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
import { appendFileSync, promises as fs } from "node:fs";
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
// How far behind the live deployment the new one may be while still counting
// as "caught up". The two are queried a moment apart and the chain moves, so
// an exact match would flap. ~300 blocks is about an hour.
const SYNC_LAG_TOLERANCE_BLOCKS = Number(
  process.env.SYNC_LAG_TOLERANCE_BLOCKS ?? "300",
);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? "20000");

const META_QUERY = "{ _meta { deployment block { number } hasIndexingErrors } }";

function resolveReleaseTag() {
  if (process.env.RELEASE_TAG) return process.env.RELEASE_TAG;
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
  if (tags) return tags.split(/\r?\n/)[0];
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
    return { ok: false, reason: `${label} unreachable: ${error.message}` };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      ok: false,
      reason: `${label} returned non-JSON (HTTP ${response.status}): ${bodyText.slice(0, 200)}`,
    };
  }

  if (payload.errors?.length) {
    const message = payload.errors.map((e) => e.message).join("; ");
    // Studio answers this way for a version label that was never deployed or
    // has since been archived. It is a distinct failure from "wrong hash".
    const missing = /does not exist|not found/i.test(message);
    return { ok: false, missing, reason: `${label}: ${message}` };
  }

  const meta = payload.data?._meta;
  if (!meta?.deployment || typeof meta.block?.number !== "number") {
    return {
      ok: false,
      reason: `${label} returned no usable _meta: ${bodyText.slice(0, 200)}`,
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
    report({
      status: "fail",
      headline: `Cannot read what production serves: ${prod.reason}`,
      details: [`proxy: ${PROXY_URL}`],
    });
    return 1;
  }

  if (!studio.ok) {
    const archived = studio.missing === true;
    report({
      status: "fail",
      headline: archived
        ? `Studio no longer serves ${releaseTag} — the version is missing or archived.`
        : `Cannot read Studio for ${releaseTag}: ${studio.reason}`,
      details: [
        `studio: ${studioUrl}`,
        `production is serving: ${prod.deployment} (block ${prod.block.toLocaleString()})`,
        ...(archived
          ? [
              "Check the version label and Studio status. Before deploying a replacement,",
              "preserve the live upstream. See docs/deployment.md > Promotion path.",
              "Use a higher version tag for recovery, then follow Consumer cutover",
              "to publish, validate the gateway endpoint, and update the proxy.",
            ]
          : []),
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

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.log(`::error::Cutover check failed to run: ${error.message}`);
    process.exitCode = 1;
  });
