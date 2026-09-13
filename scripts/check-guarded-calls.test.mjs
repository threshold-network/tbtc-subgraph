import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-guarded-calls.mjs", import.meta.url));
const binding = "let vault = TBTCVault.bind(event.address);";

function check(t, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guarded-calls-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src/nested"), { recursive: true });
  copyFileSync(scriptPath, path.join(root, "scripts/check-guarded-calls.mjs"));
  writeFileSync(path.join(root, "src/nested/mapping.ts"), source);
  const result = spawnSync(process.execPath, ["scripts/check-guarded-calls.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function assertUnguarded(result, line = 2) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /1 unguarded contract call\(s\)/);
  assert.ok(result.stdout.includes(`::error file=src/nested/mapping.ts,line=${line}::`), result.stdout);
  assert.match(result.stdout, /Unguarded contract call vault\.optimisticMintingFeeDivisor\(\)/);
}

for (const declaration of [
  binding,
  "let vault: TBTCVault = TBTCVault.bind(event.address);",
  "const vault: TBTCVault = TBTCVault.bind(event.address);",
  "var vault: TBTCVault = TBTCVault.bind(event.address);",
]) {
  test(`detects unguarded reads after ${declaration}`, (t) => {
    assertUnguarded(check(t, `${declaration}\nvault.optimisticMintingFeeDivisor();`));
  });
}

for (const access of [
  "vault . optimisticMintingFeeDivisor ();",
  "vault\n.optimisticMintingFeeDivisor();",
  "vault\n  .\n  optimisticMintingFeeDivisor\n  ();",
  "vault /* receiver */ . /* method */ optimisticMintingFeeDivisor ();",
]) {
  test(`detects whitespace in ${JSON.stringify(access)}`, (t) => {
    assertUnguarded(check(t, `${binding}\n${access}`));
  });
}

test("recognizes multiline type annotations and bind member access", (t) => {
  const source = [
    "let vault:",
    "  TBTCVault = TBTCVault",
    "  . bind (event.address);",
    "vault.optimisticMintingFeeDivisor();",
  ].join("\n");
  assertUnguarded(check(t, source), 4);
});

for (const expression of [
  "vault.optimisticMintingFeeDivisor().toString()",
  '({ text: "}", value: vault.optimisticMintingFeeDivisor() }).value',
  "/* } ` */ vault.optimisticMintingFeeDivisor()",
  "`nested ${vault.optimisticMintingFeeDivisor()}`",
  "(() => { return vault.optimisticMintingFeeDivisor(); })()",
]) {
  test(`scans template interpolation: ${expression}`, (t) => {
    assertUnguarded(check(t, binding + '\nlog.info(`fee ${' + expression + '}`, []);'));
  });
}

test("scans bindings declared inside template interpolations", (t) => {
  const source = 'log.info(`fee ${(() => { ' + binding +
    ' return vault.optimisticMintingFeeDivisor(); })()}`, []);';
  assertUnguarded(check(t, source), 1);
});

test("scans every interpolation and code following a template", (t) => {
  const result = check(t, binding + '\n' + [
    'log.info(`fee ${vault.optimisticMintingFeeDivisor()} / ${vault.optimisticMintingFeeDivisor()}`, []);',
    'vault.optimisticMintingFeeDivisor();',
  ].join("\n"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /3 unguarded contract call\(s\)/);
});

test("preserves line numbers through template text, comments, and interpolation", (t) => {
  const source = [
    binding,
    'log.info(`literal vault.optimisticMintingFeeDivisor()',
    'still literal ${',
    '  // } is inside a comment',
    '  /* another } */',
    '  vault.optimisticMintingFeeDivisor()',
    '}`, []);',
  ].join("\n");
  assertUnguarded(check(t, source), 6);
});

test("literal comment delimiters do not hide subsequent calls", (t) => {
  assertUnguarded(check(t, binding + '\nlog.info("https://example.invalid", []); vault.optimisticMintingFeeDivisor();'));
});

test("ignores comments and literal strings, including escaped template syntax", (t) => {
  const source = [
    binding,
    '// vault.optimisticMintingFeeDivisor();',
    '/* vault.optimisticMintingFeeDivisor(); */',
    'log.info("vault.optimisticMintingFeeDivisor()", []);',
    "log.info('vault.optimisticMintingFeeDivisor()', []);",
    'log.info(`vault.optimisticMintingFeeDivisor()',
    '  \\${vault.optimisticMintingFeeDivisor()} \\` still literal`, []);',
    'log.info(`${"vault.optimisticMintingFeeDivisor()"}`, []);',
  ].join("\n");
  const result = check(t, source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Guarded-call check: OK/);
});

test("allows guarded reads, safe methods, and calls on unrelated values", (t) => {
  const source = [
    "const vault: TBTCVault = TBTCVault.bind(event.address);",
    "vault.try_optimisticMintingFeeDivisor();",
    'log.info(`${vault.try_optimisticMintingFeeDivisor().value}`, []);',
    "vault.toString(); vault.toHexString(); vault.toHex();",
    "entity.save(); BigInt.fromI32(0);",
    '// let unrelated = TBTCVault.bind(event.address);',
    'const text = "let unrelated = TBTCVault.bind(event.address);";',
    "unrelated.optimisticMintingFeeDivisor();",
  ].join("\n");
  const result = check(t, source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
