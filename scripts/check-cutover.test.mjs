import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-cutover.mjs", import.meta.url));
const proxyUrl = "https://proxy.example.invalid/subgraph/mainnet";
const studioBase = "https://studio.example.invalid/query/tbtc-mainnet";

function fixture(t, { skipNetworksJson = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutover-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(scriptPath, path.join(root, "scripts/check-cutover.mjs"));
  if (!skipNetworksJson) {
    writeFileSync(
      path.join(root, "networks.json"),
      JSON.stringify({ mainnet: { Bridge: { startBlock: 1000 } } }),
    );
  }
  // Override fetch before loading the CLI: no endpoint or local socket is used.
  // `productionRaw`/`studioRaw` on CUTOVER_TEST_RESPONSES let a test supply an
  // exact `{ status, body }` response or a `{ reject }` network failure for a
  // single endpoint, bypassing the synthesized `{data:{_meta:...}}` shape.
  writeFileSync(
    path.join(root, "mock-fetch.mjs"),
    `import { appendFileSync } from "node:fs";
const responses = JSON.parse(process.env.CUTOVER_TEST_RESPONSES);
globalThis.fetch = async (url) => {
  appendFileSync(process.env.CUTOVER_TEST_REQUESTS, String(url) + "\\n");
  let meta;
  let raw;
  if (url === process.env.SUBGRAPH_PROXY_URL) {
    meta = responses.production;
    raw = responses.productionRaw;
  } else if (String(url).startsWith(process.env.STUDIO_QUERY_BASE + "/")) {
    meta = responses.studio;
    raw = responses.studioRaw;
  } else {
    throw new Error("Unexpected URL: " + url);
  }
  if (raw) {
    if (raw.reject) {
      throw new Error(raw.reject);
    }
    return new Response(raw.body, {
      status: raw.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ data: { _meta: meta } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
  );

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Cutover test",
    GIT_AUTHOR_EMAIL: "cutover-test@example.invalid",
    GIT_COMMITTER_NAME: "Cutover test",
    GIT_COMMITTER_EMAIL: "cutover-test@example.invalid",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "TAG_APPROVAL_GRACE_SECONDS",
    "STILL_INDEXING_CEILING_SECONDS",
  ]) {
    delete env[key];
  }
  function git(...args) {
    return execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git("init", "--initial-branch=main");
  // Creates an annotated tag backdated by `secondsAgo` via GIT_COMMITTER_DATE, so
  // age-gated tests (grace window, staleness ceiling) are deterministic instead of
  // racing the wall clock against a ceiling/grace value of 0.
  function tagAnnotated(name, secondsAgo = 0) {
    const date = new Date(Date.now() - secondsAgo * 1000).toISOString();
    execFileSync("git", ["tag", "-a", name, "-m", "release"], {
      cwd: root,
      env: { ...env, GIT_COMMITTER_DATE: date },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  function commit(message) {
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message);
  }
  // Creates a commit backdated by `secondsAgo` via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE.
  function commitAt(message, secondsAgo) {
    const date = new Date(Date.now() - secondsAgo * 1000).toISOString();
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message],
      {
        cwd: root,
        env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  commit("initial fixture");

  function run({
    releaseTag = "",
    production = {},
    studio = {},
    productionRaw,
    studioRaw,
    tagApprovalGraceSeconds,
    stillIndexingCeilingSeconds,
    envOverrides = {},
  } = {}) {
    const requestsPath = path.join(root, "requests.txt");
    const summaryPath = path.join(root, "summary.md");
    const result = spawnSync(
      process.execPath,
      ["--import", "./mock-fetch.mjs", "./scripts/check-cutover.mjs"],
      {
        cwd: root,
        env: {
          ...env,
          NODE_OPTIONS: "",
          RELEASE_TAG: releaseTag,
          NETWORK: "mainnet",
          SUBGRAPH_PROXY_URL: proxyUrl,
          STUDIO_QUERY_BASE: studioBase,
          SYNC_LAG_TOLERANCE_BLOCKS: "300",
          REQUEST_TIMEOUT_MS: "1000",
          GITHUB_STEP_SUMMARY: summaryPath,
          CUTOVER_TEST_REQUESTS: requestsPath,
          ...(tagApprovalGraceSeconds !== undefined
            ? { TAG_APPROVAL_GRACE_SECONDS: String(tagApprovalGraceSeconds) }
            : {}),
          ...(stillIndexingCeilingSeconds !== undefined
            ? { STILL_INDEXING_CEILING_SECONDS: String(stillIndexingCeilingSeconds) }
            : {}),
          // Raw overrides win over every default above -- used to exercise invalid
          // numeric config (NaN/Infinity/negative/fractional) that the structured
          // options can't express directly.
          ...envOverrides,
          CUTOVER_TEST_RESPONSES: JSON.stringify({
            production: {
              deployment: "QmProduction",
              block: { number: 10000 },
              hasIndexingErrors: false,
              ...production,
            },
            studio: {
              deployment: "QmProduction",
              block: { number: 10000 },
              hasIndexingErrors: false,
              ...studio,
            },
            productionRaw,
            studioRaw,
          }),
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return {
      ...result,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
      requests: existsSync(requestsPath)
        ? readFileSync(requestsPath, "utf8").trim().split("\n")
        : [],
    };
  }
  return {
    git,
    commit,
    commitAt,
    run,
    tagAnnotated,
    setReleasePointer: (tag) => writeFileSync(path.join(root, "RELEASE_POINTER"), tag),
  };
}

function assertSelectedRelease(result, tag) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    result.requests.sort(),
    [proxyUrl, `${studioBase}/${tag}`].sort(),
  );
  assert.ok(result.stdout.includes(`Production is serving ${tag}.`), result.stdout);
}

test("selects the highest release when a commit is tagged again", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.1.0");
  repo.git("tag", "v1.3.0");
  assertSelectedRelease(repo.run(), "v1.3.0");
});

test("selects a newer release tag on an older commit during rollback", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.3.0");
  repo.commit("later implementation");
  repo.git("tag", "v1.2.0");
  assertSelectedRelease(repo.run(), "v1.3.0");
});

test("selects the highest release even when it is not an ancestor of HEAD", (t) => {
  const repo = fixture(t);
  repo.git("checkout", "-b", "other-release");
  repo.commit("release on another branch");
  repo.git("tag", "v1.4.0");
  repo.git("checkout", "main");
  repo.commit("current branch");
  repo.git("tag", "v1.2.0");
  assertSelectedRelease(repo.run(), "v1.4.0");
});

test("orders release versions numerically instead of lexically", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.10.0");
  repo.commit("lower version at HEAD");
  repo.git("tag", "v1.9.0");
  assertSelectedRelease(repo.run(), "v1.10.0");
});

test("honors an explicit RELEASE_TAG over automatic version selection", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v2.0.0");
  assertSelectedRelease(repo.run({ releaseTag: "v1.1.0" }), "v1.1.0");
});

test("an empty RELEASE_TAG falls back to version selection and ignores other tags", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.3.0");
  repo.git("tag", "unrelated-99.0.0");
  assertSelectedRelease(repo.run({ releaseTag: "" }), "v1.3.0");
});

test("fails without release tags before contacting any endpoint", (t) => {
  const repo = fixture(t);
  repo.git("tag", "unrelated-1.0.0");
  const result = repo.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /No RELEASE_TAG given and no v\* tag found/);
  assert.deepEqual(result.requests, []);
});

test("passes when both healthy endpoints serve the same deployment", (t) => {
  const result = fixture(t).run({ releaseTag: "v1.3.0" });
  assertSelectedRelease(result, "v1.3.0");
  assert.match(result.stdout, /::notice::/);
  assert.match(result.summary, /Production is serving v1\.3\.0/);
});

test("reports healthy indexing progress beyond the lag tolerance", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is still indexing/);
  assert.match(result.stdout, /96\.7% synced/);
  assert.match(result.stdout, /::notice::/);
  assert.match(result.summary, /is still indexing/);
  assert.doesNotMatch(result.stdout, /Repoint the consumer|wrangler secret put/);
});

test("remediates a healthy synced release with only a secret update", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9700 } },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cutover pending: v1\.3\.0/);
  assert.match(result.stdout, /::error::/);
  for (const output of [result.stdout, result.summary]) {
    assert.match(
      output,
      /wrangler secret put SUBGRAPH_GATEWAY_URL_MAINNET --env production/,
    );
    assert.doesNotMatch(output, /bun run deploy:production/);
  }
});

for (const scenario of [
  {
    name: "Studio has errors within the lag tolerance",
    studio: {
      deployment: "QmRelease",
      block: { number: 9900 },
      hasIndexingErrors: true,
    },
    endpoint: /studio/i,
  },
  {
    name: "Studio has errors beyond the lag tolerance",
    studio: {
      deployment: "QmRelease",
      block: { number: 8000 },
      hasIndexingErrors: true,
    },
    endpoint: /studio/i,
  },
  {
    name: "Studio has errors on the currently served deployment",
    studio: { hasIndexingErrors: true },
    endpoint: /studio/i,
  },
  {
    name: "the proxy has errors on the currently served deployment",
    production: { hasIndexingErrors: true },
    endpoint: /proxy|production/i,
  },
  {
    name: "the proxy has errors while Studio is still catching up",
    production: { hasIndexingErrors: true },
    studio: { deployment: "QmRelease", block: { number: 8000 } },
    endpoint: /proxy|production/i,
  },
]) {
  test(`fails as unhealthy when ${scenario.name}`, (t) => {
    const result = fixture(t).run({ releaseTag: "v1.3.0", ...scenario });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /::error::/);
    for (const output of [result.stdout, result.summary]) {
      assert.match(output, /indexing errors/i);
      assert.match(output, scenario.endpoint);
      assert.doesNotMatch(
        output,
        /Production is serving|is still indexing|is synced|Repoint the consumer|wrangler secret put/,
      );
    }
  });
}

/* ===== New coverage: raw Studio/proxy responses (archived, never-deployed,
 * non-JSON, network rejection) that the synthesized `{data:{_meta}}` fixture
 * shape could never reach. ===== */

test("Studio no longer serving a version is reported as missing or archived", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.3.0",
    studioRaw: {
      status: 200,
      body: '{"errors":[{"message":"deployment `u59264/s49173/v357264` does not exist"}]}',
    },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Studio no longer serves v1\.3\.0 — the version is missing or archived\./,
  );
  assert.match(result.stdout, /Use a higher version tag for recovery/);
});

test("a never-deployed Studio label within the tag-approval grace window still passes", (t) => {
  const repo = fixture(t);
  repo.tagAnnotated("v1.5.0");
  const result = repo.run({
    releaseTag: "v1.5.0",
    studioRaw: {
      status: 200,
      body: '{"errors":[{"message":"deployment `u59264/s49173/v150264` does not exist"}]}',
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /v1\.5\.0 has no resolvable Studio deployment yet — within the 7200s post-tag approval window, not yet a failure\./,
  );
  assert.doesNotMatch(result.stdout, /missing or archived/);
});

test("a never-deployed Studio label outside the grace window fails with archived-version advice", (t) => {
  const repo = fixture(t);
  repo.tagAnnotated("v1.5.0");
  const result = repo.run({
    releaseTag: "v1.5.0",
    studioRaw: {
      status: 200,
      body: '{"errors":[{"message":"deployment `u59264/s49173/v150264` does not exist"}]}',
    },
    tagApprovalGraceSeconds: 0,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Past the grace period, Studio's "does not exist" response is indistinguishable from
  // a truly archived version, so it gets the same unified message and advice.
  assert.match(
    result.stdout,
    /Studio no longer serves v1\.5\.0 — the version is missing or archived\./,
  );
  assert.match(result.stdout, /Use a higher version tag for recovery/);
});

test("a non-JSON Studio response never gets grace-period treatment, even for a brand-new tag", (t) => {
  const repo = fixture(t);
  repo.tagAnnotated("v1.6.0");
  const result = repo.run({
    releaseTag: "v1.6.0",
    studioRaw: { status: 500, body: "<html>Internal Server Error</html>" },
    // A deliberately huge grace window: if "malformed" were ever treated as grace-eligible
    // (the bug this test guards against), this would silently pass instead of failing.
    tagApprovalGraceSeconds: 999999999,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const [headline, ...rest] = result.stdout.split("\n");
  assert.match(headline, /^Cannot read Studio for v1\.6\.0$/);
  assert.doesNotMatch(headline, /<html>/);
  assert.match(
    rest.join("\n"),
    /returned non-JSON \(HTTP 500\): <html>Internal Server Error<\/html>/,
  );
});

test("an unrelated GraphQL error never gets grace-period treatment, even for a brand-new tag", (t) => {
  // A GraphQL error that isn't the "does not exist" shape (e.g. a rate limit or a
  // validation error) must stay fatal regardless of tag age -- only the specific
  // does-not-exist/not-found signal is grace-eligible.
  const repo = fixture(t);
  repo.tagAnnotated("v1.6.5");
  const result = repo.run({
    releaseTag: "v1.6.5",
    studioRaw: {
      status: 200,
      body: '{"errors":[{"message":"rate limit exceeded, retry later"}]}',
    },
    tagApprovalGraceSeconds: 999999999,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Cannot read Studio for v1\.6\.5$/m);
  assert.match(result.stdout, /rate limit exceeded, retry later/);
  assert.doesNotMatch(result.stdout, /missing or archived/);
  assert.doesNotMatch(result.stdout, /post-tag approval window/);
});

test("a rejected fetch to the proxy is reported as unreachable", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.3.0",
    productionRaw: { reject: "ECONNREFUSED" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Cannot read what production serves$/m);
  assert.match(result.stdout, /proxy unreachable: ECONNREFUSED/);
});

test("a rejected fetch to Studio never gets grace-period treatment, even for a brand-new tag", (t) => {
  const repo = fixture(t);
  repo.tagAnnotated("v1.7.0");
  const result = repo.run({
    releaseTag: "v1.7.0",
    studioRaw: { reject: "ECONNREFUSED" },
    tagApprovalGraceSeconds: 999999999,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Cannot read Studio for v1\.7\.0$/m);
  assert.match(result.stdout, /Studio v1\.7\.0 unreachable: ECONNREFUSED/);
});

/* ===== New coverage: readEarliestStartBlock's catch branch and
 * resolveReleaseTag's git-command-itself-throws branch. ===== */

test("without networks.json, indexing progress is reported as unknown", (t) => {
  const repo = fixture(t, { skipNetworksJson: true });
  const result = repo.run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is still indexing/);
  assert.match(result.stdout, /\(unknown synced\)/);
});

test("fails when git tag --list itself throws outside a Git checkout", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutover-test-nogit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(scriptPath, path.join(root, "scripts/check-cutover.mjs"));
  writeFileSync(
    path.join(root, "networks.json"),
    JSON.stringify({ mainnet: { Bridge: { startBlock: 1000 } } }),
  );
  const requestsPath = path.join(root, "requests.txt");
  writeFileSync(
    path.join(root, "mock-fetch.mjs"),
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(process.env.CUTOVER_TEST_REQUESTS, String(url) + "\\n");
  throw new Error("no requests expected outside a Git checkout");
};
`,
  );
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "TAG_APPROVAL_GRACE_SECONDS",
    "STILL_INDEXING_CEILING_SECONDS",
  ]) {
    delete env[key];
  }
  const summaryPath = path.join(root, "summary.md");
  const result = spawnSync(
    process.execPath,
    ["--import", "./mock-fetch.mjs", "./scripts/check-cutover.mjs"],
    {
      cwd: root,
      env: {
        ...env,
        NODE_OPTIONS: "",
        RELEASE_TAG: "",
        NETWORK: "mainnet",
        SUBGRAPH_PROXY_URL: proxyUrl,
        STUDIO_QUERY_BASE: studioBase,
        SYNC_LAG_TOLERANCE_BLOCKS: "300",
        REQUEST_TIMEOUT_MS: "1000",
        GITHUB_STEP_SUMMARY: summaryPath,
        CUTOVER_TEST_REQUESTS: requestsPath,
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cannot list release tags\. Run from a Git checkout\./);
  assert.deepEqual(
    existsSync(requestsPath) ? readFileSync(requestsPath, "utf8").trim().split("\n") : [],
    [],
  );
});

/* ===== New coverage: RELEASE_TAG validation, pre-release tag exclusion, and
 * RELEASE_POINTER precedence/validation. ===== */

test("an invalid RELEASE_TAG fails before contacting any endpoint", (t) => {
  const result = fixture(t).run({ releaseTag: "not-a-version" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RELEASE_TAG must match/i);
  assert.deepEqual(result.requests, []);
});

test("a non-numeric STILL_INDEXING_CEILING_SECONDS fails loudly instead of masking a stalled release", (t) => {
  // Number("not-a-number") is NaN; every comparison against NaN is false, so an
  // unvalidated ceiling would let a stalled deployment pass indefinitely. Must reject
  // before contacting either endpoint, not silently disable the check.
  const result = fixture(t).run({
    releaseTag: "v1.0.0",
    envOverrides: { STILL_INDEXING_CEILING_SECONDS: "not-a-number" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /STILL_INDEXING_CEILING_SECONDS must be a non-negative integer, got: not-a-number/,
  );
  assert.deepEqual(result.requests, []);
});

test("a negative TAG_APPROVAL_GRACE_SECONDS fails loudly instead of accepting it", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.0.0",
    envOverrides: { TAG_APPROVAL_GRACE_SECONDS: "-1" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /TAG_APPROVAL_GRACE_SECONDS must be a non-negative integer, got: -1/,
  );
  assert.deepEqual(result.requests, []);
});

test("a fractional SYNC_LAG_TOLERANCE_BLOCKS fails loudly instead of accepting it", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.0.0",
    envOverrides: { SYNC_LAG_TOLERANCE_BLOCKS: "1.5" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /SYNC_LAG_TOLERANCE_BLOCKS must be a non-negative integer, got: 1\.5/,
  );
  assert.deepEqual(result.requests, []);
});

test("an Infinity REQUEST_TIMEOUT_MS fails loudly instead of accepting it", (t) => {
  const result = fixture(t).run({
    releaseTag: "v1.0.0",
    envOverrides: { REQUEST_TIMEOUT_MS: "Infinity" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /REQUEST_TIMEOUT_MS must be a non-negative integer, got: Infinity/,
  );
  assert.deepEqual(result.requests, []);
});

test("an empty-string SYNC_LAG_TOLERANCE_BLOCKS falls back to the real default, not 0", (t) => {
  // Number("") is 0, not NaN, so a naive check only for `undefined` would silently treat an
  // empty-but-set override as "0", not "unset". Proven observably, not just by absence of a
  // thrown error: a 50-block lag is well within the real default (300) but would exceed a
  // broken fallback of 0, flipping this from "cutover pending" (mismatched, caught-up hashes)
  // to "still indexing" (mismatched hashes hidden behind the too-small tolerance).
  const result = fixture(t).run({
    releaseTag: "v1.0.0",
    production: { deployment: "QmProduction", block: { number: 10000 } },
    studio: { deployment: "QmStudioPending", block: { number: 9950 } },
    envOverrides: { SYNC_LAG_TOLERANCE_BLOCKS: "" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cutover pending/);
  assert.doesNotMatch(result.stdout, /is still indexing/);
});

test("release selection filters out pre-release-shaped tags", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.4.0");
  repo.commit("pre-release candidate");
  repo.git("tag", "v1.4.0-rc1");
  assertSelectedRelease(repo.run(), "v1.4.0");
});

test("RELEASE_POINTER takes precedence over tag order", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.3.0");
  repo.commit("later release");
  repo.git("tag", "v1.5.0");
  repo.setReleasePointer("v1.3.0");
  assertSelectedRelease(repo.run(), "v1.3.0");
});

test("an explicit RELEASE_TAG still overrides RELEASE_POINTER", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.3.0");
  repo.commit("later release");
  repo.git("tag", "v1.5.0");
  repo.setReleasePointer("v1.3.0");
  assertSelectedRelease(repo.run({ releaseTag: "v1.5.0" }), "v1.5.0");
});

test("an invalid RELEASE_POINTER value fails loudly instead of falling through", (t) => {
  const repo = fixture(t);
  repo.git("tag", "v1.0.0");
  repo.setReleasePointer("not-a-version");
  const result = repo.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RELEASE_POINTER must match vX\.Y\.Z, got: not-a-version/);
  assert.deepEqual(result.requests, []);
});

/* ===== New coverage: the still-indexing staleness ceiling (#5), gated by
 * tag age so a freshly-created tag can exercise both sides deterministically. */

test("healthy indexing progress still passes well within the staleness ceiling", (t) => {
  const repo = fixture(t);
  repo.tagAnnotated("v1.3.0");
  const result = repo.run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is still indexing/);
  assert.doesNotMatch(result.stdout, /stalled/);
});

test("indexing beyond the staleness ceiling fails as stalled", (t) => {
  const repo = fixture(t);
  // Backdated well past a small, valid ceiling -- deterministic, no clock-boundary race.
  repo.tagAnnotated("v1.3.0", 3600);
  const result = repo.run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
    stillIndexingCeilingSeconds: 5,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /has been "still indexing" for \d+ days? — sync appears stalled, not merely catching up\./,
  );
  assert.doesNotMatch(result.stdout, /Cutover pending/);
});

test("a lightweight tag re-tagging an older commit is not misread as an ancient release", (t) => {
  // A lightweight tag's `creatordate` reflects the *pointed-to commit's* date, not the
  // moment the tag was created -- exactly what a recovery/rollback re-tag of an older
  // commit does (see docs/deployment.md > Rollback). Without the annotated-only guard,
  // this would misreport as however old that commit is and immediately trip the
  // staleness ceiling on a release that only just started indexing. The commit is
  // genuinely backdated (not just older in commit order) so this test would actually
  // fail -- as "stalled" -- if the annotated-only guard were ever removed.
  const repo = fixture(t);
  repo.commitAt("old commit from 30 days ago", 30 * 24 * 3600);
  repo.commit("HEAD moves on");
  repo.git("tag", "v1.3.0", "HEAD~1"); // lightweight, pointing at the backdated commit
  const result = repo.run({
    releaseTag: "v1.3.0",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
    stillIndexingCeilingSeconds: 5,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is still indexing/);
  assert.doesNotMatch(result.stdout, /stalled/);
});

test("an unresolvable tag age hard-fails a missing Studio deployment as before", (t) => {
  // RELEASE_TAG bypasses git tag lookup entirely, so "v9.9.9" is never created in this
  // fixture's repo -- getTagCreatedAt() can't resolve it and returns null. The grace-window
  // check must be skipped (not misread as "infinitely old" or "definitely young"), falling
  // through to the unconditional missing/archived hard-fail below, even with a huge grace
  // window configured.
  const repo = fixture(t);
  const result = repo.run({
    releaseTag: "v9.9.9",
    studioRaw: {
      status: 200,
      body: '{"errors":[{"message":"deployment `u59264/s49173/v999264` does not exist"}]}',
    },
    tagApprovalGraceSeconds: 999999999,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Studio no longer serves v9\.9\.9 — the version is missing or archived\./,
  );
});

test("an unresolvable tag age still passes healthy indexing progress as before", (t) => {
  // Same unresolvable-age situation, but on the still-indexing path: the staleness-ceiling
  // check must be skipped, falling through to the original unconditional pass-with-progress.
  const repo = fixture(t);
  const result = repo.run({
    releaseTag: "v9.9.9",
    studio: { deployment: "QmRelease", block: { number: 9699 } },
    stillIndexingCeilingSeconds: 0,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is still indexing/);
  assert.doesNotMatch(result.stdout, /stalled/);
});
