#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Path normalization (allowlisted-divergence per source manifest):
// Canonical tbtc-subgraph layout places subgraph ABIs at `<repoRoot>/abis`
// (no `data/tbtc-subgraph/` prefix; the entire monorepo subtree IS the
// canonical repo root). Monorepo source path was
// `data/tbtc-subgraph/abis` relative to monorepo root.
const subgraphAbiDir = path.join(repoRoot, "abis");

// Canonical-published ABI source: the monorepo version expected
// `packages/abi/dist/contracts/` in the same repo. In canonical
// subgraph context, the source of truth for tbtc-v2 ABIs lives in
// a different repo (`threshold-network/tbtc-v2`). Source is
// configurable via TBTC_V2_ABI_DIR env var; default expects the
// canonical-published npm package `@threshold-network/tbtc-v2-abi`
// to be installed in this repo's node_modules.
//
// CI integration (post-Gate-E stable ABI release):
//   pnpm install @threshold-network/tbtc-v2-abi
//   node scripts/verify-subgraph-abi-drift.mjs
//
// Pre-Gate-E (during extraction window): set
//   TBTC_V2_ABI_DIR=<path to checked-out tbtc-v2 solidity/packages/abi/dist/contracts>
const defaultCanonicalDir = path.join(
  repoRoot,
  "node_modules",
  "@threshold-network",
  "tbtc-v2-abi",
  "contracts",
);
const canonicalDir = process.env.TBTC_V2_ABI_DIR
  ? path.resolve(process.env.TBTC_V2_ABI_DIR)
  : defaultCanonicalDir;

const allowlistPath = path.join(__dirname, "abi-drift-allowlist.json");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeType(input) {
  if (!input || typeof input !== "object") {
    return "unknown";
  }

  if (input.type === "tuple") {
    const components = Array.isArray(input.components) ? input.components : [];
    return `tuple(${components.map(normalizeType).join(",")})`;
  }

  if (typeof input.type === "string" && input.type.startsWith("tuple[")) {
    const components = Array.isArray(input.components) ? input.components : [];
    const suffix = input.type.slice("tuple".length);
    return `tuple(${components.map(normalizeType).join(",")})${suffix}`;
  }

  return String(input.type ?? "unknown");
}

function normalizeEntry(entry) {
  const type = String(entry?.type ?? "unknown");
  if (type === "function") {
    const name = String(entry?.name ?? "");
    const inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
    const outputs = Array.isArray(entry?.outputs) ? entry.outputs : [];
    const stateMutability = String(entry?.stateMutability ?? "");
    return `function:${name}(${inputs.map(normalizeType).join(",")})=>(${outputs
      .map(normalizeType)
      .join(",")}):${stateMutability}`;
  }

  if (type === "event") {
    const name = String(entry?.name ?? "");
    const inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
    const params = inputs
      .map((item) => `${normalizeType(item)}:${item?.indexed ? "indexed" : "plain"}`)
      .join(",");
    return `event:${name}(${params})`;
  }

  if (type === "error") {
    const name = String(entry?.name ?? "");
    const inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
    return `error:${name}(${inputs.map(normalizeType).join(",")})`;
  }

  if (type === "constructor") {
    const inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
    return `constructor(${inputs.map(normalizeType).join(",")})`;
  }

  if (type === "fallback" || type === "receive") {
    return type;
  }

  return `${type}:${JSON.stringify(entry)}`;
}

function toNormalizedSet(abi) {
  const entries = Array.isArray(abi) ? abi : [];
  return new Set(entries.map((entry) => normalizeEntry(entry)));
}

function diffSets(leftSet, rightSet) {
  const missing = [];
  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      missing.push(value);
    }
  }
  return missing.sort();
}

if (!(await exists(canonicalDir))) {
  console.error(
    `Missing canonical ABI directory: ${canonicalDir}\n` +
      `Either install the canonical-published ABI package:\n` +
      `  pnpm install --save-dev @threshold-network/tbtc-v2-abi\n` +
      `or set TBTC_V2_ABI_DIR to point at a local checkout's solidity/packages/abi/dist/contracts:\n` +
      `  TBTC_V2_ABI_DIR=/path/to/tbtc-v2/solidity/packages/abi/dist/contracts node scripts/verify-subgraph-abi-drift.mjs`,
  );
  process.exit(1);
}

if (!(await exists(subgraphAbiDir))) {
  console.error(`Missing subgraph ABI directory: ${subgraphAbiDir}`);
  process.exit(1);
}

const subgraphEntries = (await fs.readdir(subgraphAbiDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name)
  .sort();

if (subgraphEntries.length === 0) {
  console.error("No subgraph ABI files found.");
  process.exit(1);
}

let mismatchCount = 0;
let warningCount = 0;

const allowlist = (await exists(allowlistPath))
  ? JSON.parse(await fs.readFile(allowlistPath, "utf8"))
  : {};
const allowedDiffContracts = new Set(allowlist.allowedDiffContracts ?? []);
const allowedMissingCanonicalContracts = new Set(
  allowlist.allowedMissingCanonicalContracts ?? [],
);

for (const abiFilename of subgraphEntries) {
  const contractName = path.basename(abiFilename, ".json");
  const canonicalPath = path.join(canonicalDir, `${contractName}.json`);
  const subgraphPath = path.join(subgraphAbiDir, abiFilename);

  if (!(await exists(canonicalPath))) {
    if (allowedMissingCanonicalContracts.has(contractName)) {
      warningCount += 1;
      console.warn(`Allowlisted missing canonical ABI for ${contractName}`);
    } else {
      mismatchCount += 1;
      console.error(`Missing canonical ABI for subgraph contract ${contractName}`);
    }
    continue;
  }

  let canonicalAbi;
  let subgraphAbi;
  try {
    canonicalAbi = JSON.parse(await fs.readFile(canonicalPath, "utf8"));
    subgraphAbi = JSON.parse(await fs.readFile(subgraphPath, "utf8"));
  } catch (error) {
    mismatchCount += 1;
    console.error(`Failed to parse ABI JSON for ${contractName}: ${error.message}`);
    continue;
  }

  const canonicalSet = toNormalizedSet(canonicalAbi);
  const subgraphSet = toNormalizedSet(subgraphAbi);

  const missingInCanonical = diffSets(subgraphSet, canonicalSet);
  const missingInSubgraph = diffSets(canonicalSet, subgraphSet);

  if (missingInCanonical.length > 0 || missingInSubgraph.length > 0) {
    const isAllowlisted = allowedDiffContracts.has(contractName);
    if (isAllowlisted) {
      warningCount += 1;
      console.warn(`Allowlisted ABI drift for ${contractName}`);
    } else {
      mismatchCount += 1;
      console.error(`ABI drift detected for ${contractName}`);
      if (missingInCanonical.length > 0) {
        console.error(`  Missing in canonical (${missingInCanonical.length}):`);
        for (const signature of missingInCanonical.slice(0, 20)) {
          console.error(`    - ${signature}`);
        }
      }
      if (missingInSubgraph.length > 0) {
        console.error(`  Missing in subgraph (${missingInSubgraph.length}):`);
        for (const signature of missingInSubgraph.slice(0, 20)) {
          console.error(`    - ${signature}`);
        }
      }
    }
  }
}

if (mismatchCount > 0) {
  console.error(`Subgraph ABI drift check failed for ${mismatchCount} contract(s).`);
  process.exit(1);
}

console.log(
  `Subgraph ABI drift check passed (${subgraphEntries.length} ABI files compared, ${warningCount} allowlisted warning(s)).`,
);
