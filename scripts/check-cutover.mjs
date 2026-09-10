#!/usr/bin/env node

// Answers one question: is the latest release actually what production serves?
//
// A `graph deploy` uploads the version to Studio. What `api.threshold.network`
// serves is decided by the `SUBGRAPH_GATEWAY_URL_MAINNET` secret on the
// threshold-api Cloudflare Worker, which is repointed by hand. Nothing failed
// when that step was skipped for v0.49.0 — the release simply never reached
// production, and the unqueried Studio version was later gone. This script
// turns that silent gap into a failing check.
//
// It compares two live `_meta.deployment` hashes and needs no credentials:
//   - Studio, for the release version label     -> what the release built
//   - the public proxy                          -> what production serves
//
// Outcomes:
//   FAIL      either endpoint reports indexing errors
//   PASS      healthy hashes match; the release is live
//   PASS      healthy Studio is still indexing; cutover is not due yet (prints progress)
//   FAIL      Studio is synced but production serves a different hash -> cutover pending
//   FAIL      the Studio version no longer resolves -> check missing/archived version
//   FAIL      either endpoint is unreachable or malformed
//
// Usage:
//   node scripts/check-cutover.mjs                 # checks the highest version v* tag
//   RELEASE_TAG=v1.2.3 node scripts/check-cutover.mjs

import { execFileSync } from "node:child_process";
import { appendFileSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const PROXY_URL =
  process.env.SUBGRAPH_PROXY_URL ??
  "https://api.threshold.network/subgraph/mainnet";
// Studio serves each version label at <base>/<label>. The numeric segment is
// the Studio user id that owns `tbtc-mainnet`; see docs/deployment.md.
const STUDIO_QUERY_BASE =
  process.env.STUDIO_QUERY_BASE ??
  "https://api.studio.thegraph.com/query/59264/tbtc-mainnet";
const NETWORK = process.env.NETWORK ?? "mainnet";
// Parses a config env var as a finite non-negative integer, falling back to `fallback`
// (itself trusted, always one of the literal defaults below) when unset. Rejects NaN,
// Infinity, negative values, and fractions loudly instead of letting them silently
// neutralize a comparison (e.g. a non-numeric STILL_INDEXING_CEILING_SECONDS would make
// `tagAgeSeconds > NaN` always false, masking a genuinely stalled deployment forever).
function parseNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return parsed;
}

// How far behind the live deployment the new one may be while still counting as "caught
// up" (SYNC_LAG_TOLERANCE_BLOCKS); an HTTP request budget (REQUEST_TIMEOUT_MS); a
// post-tag approval grace window (TAG_APPROVAL_GRACE_SECONDS, 2h default); and a
// still-indexing staleness ceiling (STILL_INDEXING_CEILING_SECONDS, 7d default). Parsed
// eagerly (not lazily inside main()) so a misconfiguration is reported through the same
// report()/step-summary path as every other failure below, rather than crashing with a
// raw stack trace before report() is ever called.
let SYNC_LAG_TOLERANCE_BLOCKS;
let REQUEST_TIMEOUT_MS;
let TAG_APPROVAL_GRACE_SECONDS;
let STILL_INDEXING_CEILING_SECONDS;
let configOk = true;
try {
  SYNC_LAG_TOLERANCE_BLOCKS = parseNonNegativeInt("SYNC_LAG_TOLERANCE_BLOCKS", 300);
  REQUEST_TIMEOUT_MS = parseNonNegativeInt("REQUEST_TIMEOUT_MS", 20000);
  TAG_APPROVAL_GRACE_SECONDS = parseNonNegativeInt("TAG_APPROVAL_GRACE_SECONDS", 7200);
  STILL_INDEXING_CEILING_SECONDS = parseNonNegativeInt("STILL_INDEXING_CEILING_SECONDS", 604800);
} catch (error) {
  // `report` is a hoisted function declaration further down this file; calling it here,
  // during initial module evaluation, is safe.
  report({ status: "fail", headline: `Invalid configuration: ${error.message}`, details: [] });
  console.log(`::error::Invalid configuration: ${error.message}`);
  process.exitCode = 1;
  configOk = false;
}

const META_QUERY = "{ _meta { deployment block { number } hasIndexingErrors } }";

// Helper to get tag creation timestamp (Unix epoch seconds), for an ANNOTATED tag only.
// Returns null if the git call fails (unresolvable tag, e.g. RELEASE_TAG/RELEASE_POINTER
// naming a tag not fetched locally), or if the tag is lightweight, so callers can skip
// age-based logic entirely rather than misreading an unknown age as an infinitely old one.
//
// A lightweight tag has no object of its own: `%(creatordate)` on one resolves to the
// *pointed-to commit's* author date, not the moment the tag was created. A recovery or
// rollback release re-tagging an older commit (see docs/deployment.md > Rollback) would
// then misreport as however old that commit is, immediately tripping the staleness
// ceiling on a release that just started indexing. Annotated tags carry their own
// creation time independent of the commit they point at, so only those are trusted.
function getTagCreatedAt(tag) {
  try {
    const output = execFileSync(
      "git",
      ["for-each-ref", "--format=%(objecttype) %(creatordate:unix)", `refs/tags/${tag}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const [objectType, dateStr] = output.trim().split(" ");
    if (objectType !== "tag") return null;
    const parsed = parseInt(dateStr, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveReleaseTag() {
  // (1) RELEASE_TAG env var if set (explicit override always wins)
  if (process.env.RELEASE_TAG) {
    const tag = process.env.RELEASE_TAG;
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
      throw new Error(`RELEASE_TAG must match vX.Y.Z, got: ${tag}`);
    }
    return tag;
  }

  // (2) RELEASE_POINTER file content if the file exists and its trimmed content is non-empty.
  // Read and validate are separate try/catch blocks: a missing/unreadable file falls through
  // to git-tag-order below, but a malformed *value* in an existing file must fail loudly
  // rather than be silently ignored (defeats the purpose of an operator-set override).
  const pointerPath = path.join(repoRoot, "RELEASE_POINTER");
  let pointerContent;
  try {
    pointerContent = readFileSync(pointerPath, "utf8").trim();
  } catch {
    pointerContent = "";
  }
  if (pointerContent) {
    if (!/^v\d+\.\d+\.\d+$/.test(pointerContent)) {
      throw new Error(`RELEASE_POINTER must match vX.Y.Z, got: ${pointerContent}`);
    }
    return pointerContent;
  }

  // (3) fall back to git tag-order (with semver filter) only if RELEASE_POINTER is absent or empty
  let tags;
  try {
    // Use version order across all tags, independent of HEAD ancestry or tag
    // dates. Recovery and rollback releases must use a higher version even
    // when they tag an existing or older commit.
    tags = execFileSync(
      "git",
      ["tag", "--list", "v*", "--sort=-version:refname", "--no-column"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error("Cannot list release tags. Run from a Git checkout.");
  }

  if (tags) {
    const releaseTags = tags.split(/\r?\n/).find((t) => /^v\d+\.\d+\.\d+$/.test(t));
    if (releaseTags) {
      return releaseTags;
    }
  }

  throw new Error(
    "No RELEASE_TAG given and no v* tag found. Pass RELEASE_TAG=vX.Y.Z, or " +
      "check out with fetch-depth: 0 so tags are available.",
  );
}

// The earliest startBlock is where a graft-less deploy begins indexing, so it
// is the zero point for a progress percentage. networks.json is the source of
// truth for start blocks (see docs/deployment.md).
async function readEarliestStartBlock(network) {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "networks.json"), "utf8");
    const contracts = JSON.parse(raw)[network] ?? {};
    const startBlocks = Object.values(contracts)
      .map((entry) => entry?.startBlock)
      .filter((value) => typeof value === "number");
    return startBlocks.length ? Math.min(...startBlocks) : null;
  } catch {
    return null;
  }
}

async function queryMeta(url, label) {
  let response;
  let bodyText;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Skip the Worker's 30s response cache so a cutover is observed
        // immediately rather than up to half a minute later. Harmless against
        // Studio, which ignores it.
        "x-cache-bypass": "true",
      },
      body: JSON.stringify({ query: META_QUERY }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    bodyText = await response.text();
  } catch (error) {
    return { ok: false, kind: "unreachable", reason: `${label} unreachable: ${error.message}` };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    // Collapse whitespace and strip backticks from the excerpt
    const excerpt = bodyText.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 200);
    return {
      ok: false,
      kind: "malformed",
      reason: `${label} returned non-JSON (HTTP ${response.status}): ${excerpt}`,
    };
  }

  if (payload.errors?.length) {
    const message = payload.errors.map((e) => e.message).join("; ");
    // Studio answers this way for a version label that was never deployed or has since
    // been archived -- the only failure kind eligible for the post-tag approval grace
    // period below, since it's the only one indistinguishable from "not deployed yet".
    const missing = /does not exist|not found/i.test(message);
    return {
      ok: false,
      kind: missing ? "missing" : "graphql-error",
      reason: `${label}: ${message}`,
    };
  }

  const meta = payload.data?._meta;
  if (!meta?.deployment || typeof meta.block?.number !== "number") {
    // Collapse whitespace and strip backticks from the excerpt
    const excerpt = bodyText.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 200);
    return {
      ok: false,
      kind: "malformed",
      reason: `${label} returned no usable _meta: ${excerpt}`,
    };
  }

  return {
    ok: true,
    deployment: meta.deployment,
    block: meta.block.number,
    hasIndexingErrors: Boolean(meta.hasIndexingErrors),
  };
}

function report({ status, headline, details }) {
  const lines = [`${headline}`, ...details.map((line) => `  ${line}`)];
  console.log(lines.join("\n"));

  const annotation = status === "fail" ? "error" : "notice";
  console.log(`::${annotation}::${headline}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const icon = status === "fail" ? "❌" : "✅";
    // Details are a code block, not a bullet list: they include indented
    // commands and blank spacer lines that markdown bullets would mangle.
    const summary = [
      `### ${icon} Subgraph cutover check`,
      "",
      headline,
      "",
      "```",
      ...details,
      "```",
      "",
    ].join("\n");
    // Best effort: a summary write must never change the check's verdict.
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const releaseTag = resolveReleaseTag();
  const studioUrl = `${STUDIO_QUERY_BASE}/${releaseTag}`;

  const [prod, studio] = await Promise.all([
    queryMeta(PROXY_URL, "proxy"),
    queryMeta(studioUrl, `Studio ${releaseTag}`),
  ]);

  if (!prod.ok) {
    // Move raw-body excerpt into details, keep headline short
    const excerpt = prod.reason.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 200);
    report({
      status: "fail",
      headline: `Cannot read what production serves`,
      details: [
        `proxy: ${PROXY_URL}`,
        excerpt,
      ],
    });
    return 1;
  }

  if (!studio.ok) {
    if (studio.kind !== "missing") {
      // Unreachable, non-JSON, unusable _meta, or an unrelated GraphQL error: these are
      // infrastructure/response-shape problems, not "not deployed yet". Never eligible
      // for the grace period below -- a young tag must not turn a genuine Studio outage
      // into a silent pass.
      const excerpt = studio.reason.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 200);
      report({
        status: "fail",
        headline: `Cannot read Studio for ${releaseTag}`,
        details: [
          `studio: ${studioUrl}`,
          `production is serving: ${prod.deployment} (block ${prod.block.toLocaleString()})`,
          excerpt,
        ],
      });
      return 1;
    }

    // kind === "missing": Studio has no queryable data at this version label. This is
    // the one failure Studio reports identically whether the tag was never deployed yet
    // or was deployed and later archived -- there is no way to tell them apart from the
    // response alone. Grant the post-tag approval grace period here, and only here.
    const tagCreatedAt = getTagCreatedAt(releaseTag);
    const tagAgeSeconds =
      tagCreatedAt !== null ? Math.floor(Date.now() / 1000) - tagCreatedAt : null;

    // If tag is within grace period, treat as pass (not failure). An unresolvable tag
    // age (tagAgeSeconds === null, e.g. a lightweight tag or one git can't resolve) is
    // not "definitely young" -- fall through to the hard-fail below rather than guessing.
    if (tagAgeSeconds !== null && tagAgeSeconds < TAG_APPROVAL_GRACE_SECONDS) {
      report({
        status: "pass",
        headline: `${releaseTag} has no Studio deployment yet — within the ${TAG_APPROVAL_GRACE_SECONDS}s post-tag approval window, not yet a failure.`,
        details: [
          `studio: ${studioUrl}`,
          `production is serving: ${prod.deployment} (block ${prod.block.toLocaleString()})`,
          `tag age: ${tagAgeSeconds}s (grace period: ${TAG_APPROVAL_GRACE_SECONDS}s)`,
        ],
      });
      return 0;
    }

    // Outside the grace period (or age unresolvable): missing or archived, same message
    // either way since the two are indistinguishable here.
    report({
      status: "fail",
      headline: `Studio no longer serves ${releaseTag} — the version is missing or archived.`,
      details: [
        `studio: ${studioUrl}`,
        `production is serving: ${prod.deployment} (block ${prod.block.toLocaleString()})`,
        "Check the version label and Studio status. Before deploying a replacement,",
        "preserve the live upstream. See docs/deployment.md > Promotion path.",
        "Use a higher version tag for recovery, then follow Consumer cutover",
        "to publish, validate the gateway endpoint, and update the proxy.",
      ],
    });
    return 1;
  }

  // Health must be checked before declaring a release live, progressing, or
  // ready. An unhealthy proxy is also an unreliable sync-height reference.
  if (prod.hasIndexingErrors || studio.hasIndexingErrors) {
    report({
      status: "fail",
      headline: `Indexing errors prevent a healthy cutover check for ${releaseTag}.`,
      details: [
        `studio ${releaseTag}: ${studio.deployment} at block ${studio.block.toLocaleString()} (indexing errors: ${studio.hasIndexingErrors})`,
        `production: ${prod.deployment} at block ${prod.block.toLocaleString()} (indexing errors: ${prod.hasIndexingErrors})`,
        "Investigate indexing errors before relying on the release's sync status.",
      ],
    });
    return 1;
  }

  if (prod.deployment === studio.deployment) {
    report({
      status: "pass",
      headline: `Production is serving ${releaseTag}.`,
      details: [
        `deployment: ${prod.deployment}`,
        `block: ${prod.block.toLocaleString()}`,
      ],
    });
    return 0;
  }

  // Different hashes. Either the new version is still catching up (expected,
  // cutover not due yet) or it is caught up and the cutover was missed.
  const lag = prod.block - studio.block;
  if (lag > SYNC_LAG_TOLERANCE_BLOCKS) {
    const startBlock = await readEarliestStartBlock(NETWORK);
    const progress =
      startBlock !== null && prod.block > startBlock
        ? `${(((studio.block - startBlock) / (prod.block - startBlock)) * 100).toFixed(1)}%`
        : "unknown";

    // #5: Check if tag age exceeds ceiling -> fail, else pass with progress. An unresolvable
    // tag age (tagAgeSeconds === null) is not "definitely stalled" -- fall through to the
    // original unconditional-pass-with-progress behavior below rather than guessing.
    const tagCreatedAt = getTagCreatedAt(releaseTag);
    const tagAgeSeconds =
      tagCreatedAt !== null ? Math.floor(Date.now() / 1000) - tagCreatedAt : null;
    if (tagAgeSeconds !== null && tagAgeSeconds > STILL_INDEXING_CEILING_SECONDS) {
      const ageDays = Math.floor(tagAgeSeconds / 86400);
      report({
        status: "fail",
        headline: `${releaseTag} has been "still indexing" for ${ageDays} day${ageDays === 1 ? "" : "s"} — sync appears stalled, not merely catching up.`,
        details: [
          `studio ${releaseTag}: ${studio.deployment} at block ${studio.block.toLocaleString()}`,
          `production:  ${prod.deployment} at block ${prod.block.toLocaleString()}`,
          `${lag.toLocaleString()} blocks behind`,
        ],
      });
      return 1;
    }

    // Below ceiling: keep today's pass-with-progress behavior
    report({
      status: "pass",
      headline: `${releaseTag} is still indexing — cutover is not due yet (${progress} synced).`,
      details: [
        `studio ${releaseTag}: ${studio.deployment} at block ${studio.block.toLocaleString()}`,
        `production:  ${prod.deployment} at block ${prod.block.toLocaleString()}`,
        `${lag.toLocaleString()} blocks behind`,
      ],
    });
    return 0;
  }

  report({
    status: "fail",
    headline: `Cutover pending: ${releaseTag} has caught up in Studio but production serves a different deployment.`,
    details: [
      `studio ${releaseTag}: ${studio.deployment} at block ${studio.block.toLocaleString()}`,
      `production:  ${prod.deployment} at block ${prod.block.toLocaleString()}`,
      "",
      "Follow docs/deployment.md > Consumer cutover to publish and validate",
      "the deployment-pinned gateway URL. After verification, set that URL",
      "at the prompt from a threshold-api checkout:",
      "  wrangler secret put SUBGRAPH_GATEWAY_URL_MAINNET --env production",
      "The secret update takes effect immediately; re-run this check to verify.",
    ],
  });
  return 1;
}

if (configOk) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // #10: Also call report so a step summary always exists
      report({ status: "fail", headline: `Cutover check failed to run: ${error.message}`, details: [] });
      console.log(`::error::Cutover check failed to run: ${error.message}`);
      process.exitCode = 1;
    });
}