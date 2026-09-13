import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the actual handler body with contract/store dependencies injected.
// Node strips AssemblyScript's type annotations; the network builds separately
// verify the mappings against graph-ts and the generated contract bindings.
function loadHandler(mapping) {
  const source = readFileSync(new URL(`../src/mapping${mapping}.ts`, import.meta.url), "utf8");
  const start = source.indexOf("export function handleDkgResultSubmitted(");
  const end = source.indexOf("\nexport function ", start + 1);
  assert.ok(start >= 0 && end > start, "DKG handler must be present");
  return stripTypeScriptTypes(source.slice(start, end)).replace(/^export /, "") +
    "\nhandleDkgResultSubmitted;";
}

function address(value) {
  return { toHexString: () => value, toHex: () => value };
}

function runHandler(code, { memberIds = [7, 7, 9], revert = "" } = {}) {
  const calls = [];
  const warnings = [];
  const memberships = [];
  const operators = [];
  const publicKeys = [];
  let groupSaves = 0;
  let statusSaves = 0;
  const group = { id: "group", createdAt: 0n, save() { groupSaves++; } };
  const status = { save() { statusSaves++; } };
  // Separate objects model graph-ts BigInts: duplicate IDs must be compared by
  // value, not object identity.
  const ids = memberIds.map((id) => ({ toString: () => String(id) }));
  const event = {
    address: address("contract"),
    params: { result: { members: ids, groupPubKey: address("pubkey") } },
    block: { timestamp: 123n, number: 456n },
    transaction: { hash: address("transaction") },
  };
  function result(method, value, reverted = revert === method) {
    calls.push(method);
    return {
      reverted,
      get value() {
        assert.equal(reverted, false, "reverted results must not be read");
        return value;
      },
    };
  }
  const contract = {
    try_sortitionPool: () => result("sortitionPool", address("pool")),
    try_operatorToStakingProvider: (operator) => result(
      "operatorToStakingProvider",
      operator,
      revert === "operatorToStakingProvider" && operator.toHexString() === "operator-9",
    ),
  };
  const dependencies = {
    Const: { ZERO_BI: 0n },
    Address: { fromString: address },
    RandomBeacon: { bind: () => contract },
    WalletRegistry: { bind: () => contract },
    SortitionPool: { bind: () => ({
      try_getIDOperators(receivedIds) {
        assert.equal(receivedIds, ids);
        return result("getIDOperators", memberIds.map((id) => address(`operator-${id}`)));
      },
    }) },
    log: { warning: (...args) => warnings.push(args) },
    getOrCreateRandomBeaconGroup: () => group,
    getBeaconGroupId: () => group.id,
    getStatus: () => status,
    getOrCreateOperator: (provider) => ({
      id: provider.toHexString(),
      beaconGroupCount: 0,
      save() { operators.push({ ...this }); },
    }),
    keccak256TwoString: (first, second) => `${first}:${second}`,
    RandomBeaconGroupMembership: class {
      constructor(id) { this.id = id; }
      save() { memberships.push({ ...this, seats: Array.from(this.seats) }); }
    },
    GroupPublicKey: class {
      static load() { return null; }
      constructor(id) { this.id = id; }
      save() { publicKeys.push({ ...this }); }
    },
  };
  runInNewContext(code, dependencies)(event);
  return { group, groupSaves, status, statusSaves, calls, warnings, memberships, operators, publicKeys };
}

for (const mapping of ["RandomBeacon", "WalletRegistry"]) {
  const handler = loadHandler(mapping);
  const stateField = mapping === "RandomBeacon" ? "groupState" : "ecdsaState";
  const firstSeat = mapping === "RandomBeacon" ? 0 : 1;

  for (const revert of ["sortitionPool", "getIDOperators"]) {
    test(`${mapping} preserves event counts and saves state when ${revert} reverts`, () => {
      const actual = runHandler(handler, { revert });
      assert.equal(actual.group.size, 3);
      assert.equal(actual.group.uniqueMemberCount, 2);
      assert.equal(actual.group.createdAt, 123n);
      assert.equal(actual.group.createdAtBlock, 456n);
      assert.equal(actual.groupSaves, 1);
      assert.equal(actual.status[stateField], "CHALLENGE");
      assert.equal(actual.statusSaves, 1);
      assert.equal(actual.memberships.length, 0);
      assert.equal(actual.operators.length, 0);
      assert.equal(actual.warnings.length, 1);
      assert.deepEqual(actual.calls, revert === "sortitionPool"
        ? ["sortitionPool"] : ["sortitionPool", "getIDOperators"]);
      if (mapping === "WalletRegistry") {
        assert.equal(actual.group.isWalletRegistry, true);
        assert.equal(actual.publicKeys.length, 1);
        assert.equal(actual.publicKeys[0].group, actual.group.id);
      }
    });
  }

  test(`${mapping} retains counts and seat assignments when enrichment succeeds`, () => {
    const actual = runHandler(handler);
    assert.equal(actual.group.size, 3);
    assert.equal(actual.group.uniqueMemberCount, 2);
    assert.equal(actual.groupSaves, 1);
    assert.equal(actual.status[stateField], "CHALLENGE");
    assert.equal(actual.warnings.length, 0);
    assert.deepEqual(actual.memberships.map(({ count, seats }) => ({ count, seats })), [
      { count: 2, seats: [firstSeat, firstSeat + 1] },
      { count: 1, seats: [firstSeat + 2] },
    ]);
    assert.deepEqual(actual.operators.map(({ beaconGroupCount }) => beaconGroupCount), [1, 1]);
  });

  test(`${mapping} retains total counts when one operator lookup reverts`, () => {
    const actual = runHandler(handler, { revert: "operatorToStakingProvider" });
    assert.equal(actual.group.size, 3);
    assert.equal(actual.group.uniqueMemberCount, 2);
    assert.equal(actual.memberships.length, 1);
    assert.deepEqual(actual.memberships[0].seats, [firstSeat, firstSeat + 1]);
    assert.equal(actual.warnings.length, 1);
    assert.equal(actual.status[stateField], "CHALLENGE");
  });

  test(`${mapping} supports an empty event member list`, () => {
    const actual = runHandler(handler, { memberIds: [] });
    assert.equal(actual.group.size, 0);
    assert.equal(actual.group.uniqueMemberCount, 0);
    assert.equal(actual.memberships.length, 0);
    assert.equal(actual.status[stateField], "CHALLENGE");
  });
}
