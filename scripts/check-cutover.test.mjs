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

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutover-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(scriptPath, path.join(root, "scripts/check-cutover.mjs"));
  writeFileSync(
    path.join(root, "networks.json"),
    JSON.stringify({ mainnet: { Bridge: { startBlock: 1000 } } }),
  );
  // Override fetch before loading the CLI: no endpoint or local socket is used.
  writeFileSync(
    path.join(root, "mock-fetch.mjs"),
    `import { appendFileSync } from "node:fs";
const responses = JSON.parse(process.env.CUTOVER_TEST_RESPONSES);
globalThis.fetch = async (url) => {
  appendFileSync(process.env.CUTOVER_TEST_REQUESTS, String(url) + "\\n");
  let meta;
  if (url === process.env.SUBGRAPH_PROXY_URL) {
    meta = responses.production;
  } else if (String(url).startsWith(process.env.STUDIO_QUERY_BASE + "/")) {
    meta = responses.studio;
  } else {
    throw new Error("Unexpected URL: " + url);
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
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
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
  function commit(message) {
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message);
  }
  commit("initial fixture");

  function run({ releaseTag = "", production = {}, studio = {} } = {}) {
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
  return { git, commit, run };
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
