#!/usr/bin/env node

// Fails when a mapping calls a contract without the `try_` variant.
//
// graph-ts gives every generated contract method two forms. `foo()` aborts the
// whole mapping if the call reverts, which stops the subgraph; `try_foo()`
// returns `{reverted, value}` so the handler can decide. On an upgradeable
// proxy the unguarded form is a time bomb: the call works against today's
// implementation and reverts against the one live at some historical block,
// and because this subgraph has no graft, every release replays all of history.
//
// That is not hypothetical here. `handleDepositRevealed` called
// `Bridge.deposits()` unguarded; the repo ABI declares the current 7-field
// DepositRequest, which does not decode against the 2023 implementation, and
// the v0.50.0 sync died at block 16523905 having reached 27%. Recovery cost a
// fresh tag, an approval, and a full re-sync.
//
// This check exists so that class of bug cannot come back silently.
//
// Usage:
//   node scripts/check-guarded-calls.mjs

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const mappingsDir = path.join(repoRoot, "src");

// Names bound via `X.bind(...)` are contract handles; a call on one of them is
// what we police. Tracking the actual binding avoids flagging every unrelated
// method call in the file (entity `.save()`, `BigInt.fromI32()`, and so on).
const BIND_RE = /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.bind\s*\(/g;
// A call on a bound handle: `handle.method(`. `try_` prefixed ones are fine.
const CALL_RE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;

// Reads on a handle that cannot revert, so they need no guard.
const SAFE_METHODS = new Set(["bind", "toString", "toHexString", "toHex"]);

async function listMappingFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMappingFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

// Strips comments and string literals so a `.foo(` inside either cannot be
// mistaken for a call. Newlines are preserved so line numbers stay accurate.
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, " "));
}

function findUnguarded(source, relPath) {
  const clean = stripNoise(source);

  const handles = new Set();
  for (const m of clean.matchAll(BIND_RE)) handles.add(m[1]);
  if (!handles.size) return [];

  const lineStarts = [0];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const findings = [];
  for (const m of clean.matchAll(CALL_RE)) {
    const [, handle, method] = m;
    if (!handles.has(handle)) continue;
    if (method.startsWith("try_")) continue;
    if (SAFE_METHODS.has(method)) continue;
    const line = lineOf(m.index);
    findings.push({
      file: relPath,
      line,
      handle,
      method,
      text: source.split("\n")[line - 1]?.trim() ?? "",
    });
  }
  return findings;
}

async function main() {
  const files = await listMappingFiles(mappingsDir);
  const findings = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    findings.push(...findUnguarded(source, path.relative(repoRoot, file)));
  }

  if (!findings.length) {
    console.log(
      `Guarded-call check: OK — every contract call in ${files.length} mapping files uses try_*.`,
    );
    return 0;
  }

  console.log(
    `Guarded-call check: ${findings.length} unguarded contract call(s).\n`,
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    ${f.text}`);
    console.log(
      `    -> use ${f.handle}.try_${f.method}(...) and handle .reverted\n`,
    );
    console.log(`::error file=${f.file},line=${f.line}::Unguarded contract call ${f.handle}.${f.method}() — use try_${f.method}() so a revert cannot halt indexing`);
  }
  console.log(
    "An unguarded call aborts the mapping when it reverts, which halts the\n" +
      "subgraph and costs a full re-sync to recover. See docs/deployment.md.",
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.log(`::error::Guarded-call check failed to run: ${error.message}`);
    process.exitCode = 1;
  });
