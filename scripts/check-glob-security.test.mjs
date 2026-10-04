import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Inspect every installed copy, including nested dependencies: patch-package
// patches the hoisted braces copy, so a new unpatched copy must fail this gate.
function installedPackages(name, modules = path.join(repoRoot, "node_modules")) {
  const found = [];
  if (!existsSync(modules)) return found;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const directory = path.join(modules, entry.name);
    const packages = entry.name.startsWith("@")
      ? readdirSync(directory).map((child) => path.join(directory, child))
      : [directory];
    for (const packageRoot of packages) {
      const manifest = path.join(packageRoot, "package.json");
      if (!existsSync(manifest)) continue;
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      if (metadata.name === name) found.push({ packageRoot, ...metadata });
      found.push(...installedPackages(name, path.join(packageRoot, "node_modules")));
    }
  }
  return found;
}

const braceCopies = installedPackages("braces");
const expansionCopies = installedPackages("brace-expansion");
assert.ok(braceCopies.length > 0, "braces must be installed before testing its patch");
assert.ok(expansionCopies.length > 0, "brace-expansion must be installed");

for (const { packageRoot, version } of braceCopies) {
  const braces = require(packageRoot);
  const label = path.relative(repoRoot, packageRoot);
  const depthError = (error) => /exceeds max depth \(100\)/.test(error.message)
    && (error instanceof SyntaxError || error instanceof RangeError);

  test(`${label}: every string API bounds braces, parentheses, and mixed nesting`, () => {
    assert.equal(version, "3.0.3", "revisit the temporary advisory exception when upgrading braces");
    for (const operation of [braces, braces.parse, braces.compile, braces.expand, braces.stringify, braces.create]) {
      for (const [open, close] of [["{", "}"], ["(", ")"], ["{(", ")}"]]) {
        const pattern = open.repeat(2000) + "a,b" + close.repeat(2000);
        assert.throws(() => operation(pattern), depthError);
      }
      for (const maxDepth of [101, 10_000, Infinity, NaN, "10000"]) {
        assert.throws(() => operation("{".repeat(101) + "a,b" + "}".repeat(101), { maxDepth }), depthError);
      }
      assert.doesNotThrow(() => operation("{".repeat(100) + "a,b" + "}".repeat(100)));
      assert.throws(() => operation("{".repeat(101) + "a,b" + "}".repeat(101)), depthError);
    }
    assert.throws(() => braces(["{a,b}", "(".repeat(101) + "x" + ")".repeat(101)]), depthError);
    assert.doesNotThrow(() => braces.parse("{a,b}", { maxDepth: 1.5 }));
    assert.throws(() => braces.parse("{{a,b},c}", { maxDepth: 1.5 }), /exceeds max depth \(1.5\)/);
  });

  test(`${label}: direct ASTs and parent cycles cannot bypass the parser guard`, () => {
    for (const operation of [braces.compile, braces.expand, braces.stringify]) {
      let ast = { type: "text", value: "a" };
      for (let i = 0; i < 4000; i++) ast = { type: "brace", nodes: [ast] };
      assert.throws(() => operation({ type: "root", nodes: [ast] }), depthError);
      const cyclic = { type: "brace", nodes: [] };
      cyclic.nodes.push(cyclic);
      assert.throws(() => operation({ type: "root", nodes: [cyclic] }), depthError);
    }
    for (const length of [1, 2]) {
      const node = { type: "paren", nodes: [{ type: "text", value: "a" }] };
      node.parent = length === 1 ? node : { type: "paren", parent: node };
      assert.throws(() => braces.expand(node), /AST parent chain contains a cycle/);
    }
  });

  test(`${label}: ordinary expansion, ranges, literals, and stringify behavior remain intact`, () => {
    assert.deepEqual(braces.expand("src/{mapping{Bridge,TBTCVault},utils/{helper,utils}}.ts"), [
      "src/mappingBridge.ts", "src/mappingTBTCVault.ts", "src/utils/helper.ts", "src/utils/utils.ts",
    ]);
    assert.deepEqual(braces.expand("file-{01..03}.{ts,js}"), [
      "file-01.ts", "file-01.js", "file-02.ts", "file-02.js", "file-03.ts", "file-03.js",
    ]);
    assert.equal(braces.compile("src/{a,b}.ts"), "src/(a|b).ts");
    assert.deepEqual(braces.expand("foo/({a,b})"), ["foo/(a)", "foo/(b)"]);
    assert.deepEqual(braces.expand("{a,a,,b}", { nodupes: true, noempty: true }), ["a", "b"]);
    assert.throws(() => braces.expand("{1..1001}"), /range limit/);
    for (const pattern of ["{{a}}", "{a,{b}}", "{{x}y}", "{a,{b,{c}}", "{}{a}", "{1..8}"]) {
      assert.equal(braces.stringify(braces.parse(pattern), { escapeInvalid: true }), pattern);
    }
    for (const pattern of ["\\{".repeat(200), '"' + "{".repeat(200) + '"', "[" + "{".repeat(200) + "]"]) {
      assert.doesNotThrow(() => braces.compile(pattern));
    }
  });
}

for (const { packageRoot, version } of expansionCopies) {
  const loaded = require(packageRoot);
  const expand = loaded.expand ?? loaded.default ?? loaded;
  const minimum = { 1: 21, 2: 7, 5: 12 };
  const [major, minor, patch] = version.split(".").map(Number);
  test(`${path.relative(repoRoot, packageRoot)}: patched release handles both stack exhaustion classes`, () => {
    assert.ok(major in minimum, `review new brace-expansion major ${version}`);
    assert.ok(minor > (major === 5 ? 0 : 1) || (minor === (major === 5 ? 0 : 1) && patch >= minimum[major]), version);
    assert.doesNotThrow(() => expand("{".repeat(4000) + "a,b" + "}".repeat(4000)));
    assert.doesNotThrow(() => expand("{" + "{a},".repeat(7000) + "b}"));
    // The third advisory concerns quadratic rewriting rather than stack depth.
    // Fixed releases cap those rewrites; the vulnerable version takes seconds.
    const started = performance.now();
    assert.doesNotThrow(() => expand("{a}" + "}".repeat(64_000) + ",z}"));
    assert.ok(performance.now() - started < 2000, "brace rewriting must remain bounded");
    assert.deepEqual(expand("src/{a,b}.ts"), ["src/a.ts", "src/b.ts"]);
  });
}

test("micromatch and fast-glob retain normal matching and reject hostile nested braces", () => {
  const micromatch = require("micromatch");
  const fastGlob = require("fast-glob");
  const names = ["src/mappingBridge.ts", "src/mappingTBTCVault.ts", "src/utils/helper.ts"];
  assert.deepEqual(micromatch(names, "src/{mappingBridge,mappingTBTCVault}.ts"), names.slice(0, 2));
  assert.deepEqual(fastGlob.sync("src/{mappingBridge,mappingTBTCVault}.ts", { cwd: repoRoot }).sort(), names.slice(0, 2));
  const pattern = "{".repeat(2000) + "a,b" + "}".repeat(2000);
  assert.throws(() => micromatch.braces(pattern), /exceeds max depth/);
  assert.throws(() => fastGlob.sync(pattern, { cwd: repoRoot }), /exceeds max depth/);
});
