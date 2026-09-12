import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cliRoot = path.dirname(require.resolve("@graphprotocol/graph-cli/package.json"));
const { extractZipAndGetExe } = await import(
  pathToFileURL(path.join(cliRoot, "dist/command-helpers/local-node.js"))
);
const { chooseNodeUrl } = await import(
  pathToFileURL(path.join(cliRoot, "dist/command-helpers/node.js"))
);

test("CLI defaults to Subgraph Studio without the removed --studio flag", () => {
  assert.deepEqual(chooseNodeUrl({}), { node: "https://api.studio.thegraph.com/deploy/" });
});

function tempDir(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "graph-toolchain-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Small stored ZIP fixtures let us specify duplicate names and Unix symlinks
// without downloading an archive or depending on a system zip executable.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, content, mode = 0o100644 } of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // January 1, 1980
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4); // Unix file attributes
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("CLI ZIP helper extracts a harmless executable through the maintained alias", async (t) => {
  const root = tempDir(t);
  const cliRequire = createRequire(path.join(cliRoot, "package.json"));
  const decompressPackage = JSON.parse(readFileSync(
    path.join(path.dirname(cliRequire.resolve("decompress")), "package.json"), "utf8",
  ));
  assert.equal(decompressPackage.name, "@xhmikosr/decompress");
  const archive = path.join(root, "release.zip");
  const output = path.join(root, "output");
  writeFileSync(archive, zip([
    { name: "release/gnd.exe", content: "Harmless test fixture; never executed." },
    { name: "README.txt", content: "ZIP compatibility smoke test" },
  ]));
  const exe = await extractZipAndGetExe(archive, output);
  assert.equal(exe, path.join(output, "release/gnd.exe"));
  assert.equal(readFileSync(exe, "utf8"), "Harmless test fixture; never executed.");
  assert.equal(readFileSync(path.join(output, "README.txt"), "utf8"), "ZIP compatibility smoke test");
});

test("CLI ZIP helper rejects traversal and duplicate/link escape classes", async (t) => {
  const cases = [
    {
      name: "parent directory traversal",
      entries: [{ name: "../sentinel.exe", content: "overwritten" }],
      error: /invalid relative path|outside/i,
    },
    {
      name: "duplicate file and symlink destinations",
      entries: [
        { name: "gnd.exe", content: "overwritten" },
        { name: "gnd.exe", content: "../sentinel.exe", mode: 0o120777 },
      ],
      error: /duplicate entry path/i,
    },
    {
      name: "symlink target outside extraction directory",
      entries: [{ name: "gnd.exe", content: "../sentinel.exe", mode: 0o120777 }],
      error: /outside.*output|escapes.*output/i,
    },
    {
      name: "write through preexisting destination symlink",
      entries: [{ name: "gnd.exe", content: "overwritten" }],
      plantedSymlink: true,
      error: /symlink|ELOOP/i,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const root = tempDir(t);
      const output = path.join(root, "output");
      const sentinel = path.join(root, "sentinel.exe");
      const archive = path.join(root, "release.zip");
      mkdirSync(output);
      writeFileSync(sentinel, "unchanged");
      if (fixture.plantedSymlink) symlinkSync(sentinel, path.join(output, "gnd.exe"));
      writeFileSync(archive, zip(fixture.entries));
      await assert.rejects(extractZipAndGetExe(archive, output), fixture.error);
      assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
      if (!fixture.plantedSymlink) assert.equal(existsSync(path.join(output, "gnd.exe")), false);
    });
  }
});

function subgraphFixture(t) {
  const root = tempDir(t);
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(path.join(root, "schema.graphql"), "type SmokeEntity @entity(immutable: false) { id: ID! value: BigInt! }\n");
  writeFileSync(path.join(root, "Smoke.json"), "[]\n");
  writeFileSync(path.join(root, "mapping.ts"), `
import { ethereum, log } from "@graphprotocol/graph-ts";
export function handleBlock(block: ethereum.Block): void {
  log.info("toolchain smoke block {}", [block.number.toString()]);
}
`);
  writeFileSync(path.join(root, "subgraph.yaml"), `
specVersion: 0.0.5
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: Smoke
    network: mainnet
    source:
      address: "0x0000000000000000000000000000000000000001"
      abi: Smoke
      startBlock: 1
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      entities: [SmokeEntity]
      abis:
        - name: Smoke
          file: ./Smoke.json
      blockHandlers:
        - handler: handleBlock
      file: ./mapping.ts
`);
  return root;
}

// A valid, deterministic CIDv0 per upload. The mock is an HTTP contract fixture,
// not an IPFS implementation; these hashes do not represent UnixFS DAGs.
function fixtureCid(data) {
  const bytes = Buffer.concat([Buffer.from([0x12, 0x20]), createHash("sha256").update(data).digest()]);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let cid = "";
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while (value > 0n) {
    cid = alphabet[Number(value % 58n)] + cid;
    value /= 58n;
  }
  return cid;
}

async function mockGraph(t, failDeploy) {
  const uploads = [];
  const pins = [];
  const deployments = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      const url = new URL(req.url, "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/v0/add") {
        const boundary = req.headers["content-type"]?.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
        assert.ok(boundary, "Kubo must send a multipart upload");
        const headerEnd = body.indexOf("\r\n\r\n");
        const header = body.subarray(0, headerEnd).toString();
        const filename = header.match(/filename="([^"]+)"/)?.[1];
        assert.ok(filename, "upload must include its file path");
        const end = body.lastIndexOf(`\r\n--${boundary}--`);
        assert.ok(headerEnd > 0 && end > headerEnd);
        const content = body.subarray(headerEnd + 4, end);
        const name = decodeURIComponent(filename);
        const hash = fixtureCid(content);
        uploads.push({ name, hash, content });
        res.end(`${JSON.stringify({ Name: name, Hash: hash, Size: String(content.length) })}\n`);
      } else if (url.pathname === "/api/v0/pin/add") {
        const hash = url.searchParams.get("arg");
        assert.ok(uploads.some((upload) => upload.hash === hash), "pin must refer to an uploaded file");
        pins.push(hash);
        res.end(`${JSON.stringify({ Pins: [hash] })}\n`);
      } else if (url.pathname === "/rpc") {
        const rpc = JSON.parse(body.toString());
        deployments.push({ rpc, authorization: req.headers.authorization });
        const response = failDeploy
          ? { error: { code: -32000, message: "fixture deployment rejected" } }
          : { result: { playground: "http://127.0.0.1/fixture-playground", queries: "http://127.0.0.1/fixture-query" } };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...response }));
      } else {
        throw new Error(`Unexpected mock request: ${req.url}`);
      }
    } catch (error) {
      errors.push(error);
      res.statusCode = 500;
      res.end(JSON.stringify({ Message: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, uploads, pins, deployments, errors };
}

async function deploy(t, root, port) {
  // All socket connections are restricted to this test's mock. An accidental
  // default endpoint or background version check cannot reach a real service.
  const preload = path.join(root, "only-loopback.mjs");
  writeFileSync(preload, `
import { Socket } from "node:net";
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" ? first : { port: first, host: args[1] };
  if (options.host !== "127.0.0.1" || Number(options.port) !== ${port}) {
    throw new Error("Toolchain test blocked a connection outside the local mock");
  }
  return Reflect.apply(connect, this, args);
};
`);
  const child = spawn(process.execPath, [
    "--import", preload, path.join(cliRoot, "bin/run.js"),
    "deploy", "fixture/toolchain", "subgraph.yaml",
    "--node", `http://127.0.0.1:${port}/rpc`,
    "--ipfs", `http://127.0.0.1:${port}`,
    "--deploy-key", "fake-toolchain-test-key",
    "--version-label", "toolchain-test-v1",
    "--skip-migrations",
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      CI: "1",
      NO_COLOR: "1",
      GRAPH_SKIP_NEW_VERSION_CHECK: "true",
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, `CLI was killed or timed out:\n${output}`);
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}

for (const failDeploy of [false, true]) {
  test(`graph deploy uploads via Kubo and ${failDeploy ? "reports RPC failure" : "deploys via authenticated RPC"}`, { timeout: 60_000 }, async (t) => {
    const root = subgraphFixture(t);
    const mock = await mockGraph(t, failDeploy);
    const { code, output } = await deploy(t, root, mock.port);
    assert.deepEqual(mock.errors, [], output);
    assert.equal(code, failDeploy ? 1 : 0, output);
    assert.deepEqual(mock.uploads.map((upload) => upload.name).sort(), [
      "Smoke/Smoke.json", "Smoke/Smoke.wasm", "schema.graphql", "subgraph.yaml",
    ]);
    const wasm = mock.uploads.find((upload) => upload.name.endsWith(".wasm"));
    assert.deepEqual(wasm.content.subarray(0, 4), Buffer.from([0, 0x61, 0x73, 0x6d]));
    assert.deepEqual(mock.pins, mock.uploads.map((upload) => upload.hash));
    const manifest = mock.uploads.find((upload) => upload.name === "subgraph.yaml");
    for (const upload of mock.uploads.filter((upload) => upload !== manifest)) {
      assert.ok(manifest.content.includes(`/ipfs/${upload.hash}`), `manifest must reference ${upload.name}`);
    }
    assert.equal(mock.deployments.length, 1, output);
    const { rpc, authorization } = mock.deployments[0];
    assert.equal(authorization, "Bearer fake-toolchain-test-key");
    assert.equal(rpc.jsonrpc, "2.0");
    assert.match(rpc.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(rpc.method, "subgraph_deploy");
    assert.deepEqual(rpc.params, {
      name: "fixture/toolchain",
      ipfs_hash: manifest.hash,
      version_label: "toolchain-test-v1",
    });
    if (failDeploy) {
      assert.match(output, /fixture deployment rejected/);
      assert.doesNotMatch(output, /Deployed to|Subgraph endpoints:/);
    } else {
      assert.match(output, /Deployed to http:\/\/127\.0\.0\.1\/fixture-playground/);
      assert.match(output, /Queries \(HTTP\):\s+http:\/\/127\.0\.0\.1\/fixture-query/);
    }
  });
}
