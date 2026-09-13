import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

// Execute the real mapping, with only its Graph host and imported dependencies
// mocked. AssemblyScript compilation remains covered by codegen + graph build;
// this harness checks handler behavior and persisted values in event order.
const mappingPath = new URL("../src/mappingBridge.ts", import.meta.url);

class GraphBigInt {
  constructor(value) { this.value = BigInt(value); Object.freeze(this); }
  static fromI32(value) { return new GraphBigInt(value); }
  static fromString(value) { return new GraphBigInt(value); }
  toI32() { return Number(this.value); }
  toString() { return String(this.value); }
}

class Bytes extends Uint8Array {
  static fromByteArray(value) { return new Bytes(value); }
  static fromUint8Array(value) { return new Bytes(value); }
  static fromHexString(value) { return new Bytes(Buffer.from(value.slice(2), "hex")); }
  toHexString() { return `0x${Buffer.from(this).toString("hex")}`; }
  equals(other) { return this.toHexString() === other.toHexString(); }
}

const integer = (value) => GraphBigInt.fromString(String(value));
const bytes = (value, length = 32) => Bytes.fromHexString(`0x${BigInt(value).toString(16).padStart(length * 2, "0")}`);
const key = (id) => id instanceof Bytes ? id.toHexString() : String(id);
const unexpected = (name) => () => { throw new Error(`Unmocked mapping dependency: ${name}`); };

// Graph entities are loaded/saved as independent records. Copy arrays as well
// so mutating a loaded record cannot change a previously persisted snapshot.
function copyEntity(entity) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity);
  for (const [name, value] of Object.entries(copy)) {
    if (Array.isArray(value)) copy[name] = [...value];
  }
  return copy;
}

function entityType(defaults = () => ({})) {
  const records = new Map();
  return class Entity {
    constructor(id) { Object.assign(this, defaults(), { id }); }
    static load(id) { return records.has(key(id)) ? copyEntity(records.get(key(id))) : null; }
    save() { records.set(key(this.id), copyEntity(this)); }
  };
}

export async function createBridgeHarness({
  endOfBlockDivisor = 500,
  mappingSource = readFileSync(mappingPath, "utf8"),
} = {}) {
  const BridgeState = entityType(() => ({ depositTreasuryFeeDivisor: null }));
  const Deposit = entityType(() => ({
    status: "UNKNOWN", amount: integer(0), treasuryFee: integer(0),
    treasuryFeeDivisorAtReveal: null, transactions: [],
  }));
  const Transaction = entityType();
  const User = entityType(() => ({ deposits: [] }));
  const Stats = entityType(() => ({ numDeposits: 0 }));
  const WalletSchemeChange = entityType();
  const loadOrCreate = (Type, id) => Type.load(id) ?? new Type(id);
  const depositCalls = new Map();
  const warnings = [];
  let parameterCalls = 0;
  let sequence = 0;

  // Key derivation is outside the behavior under test. Use a deterministic,
  // collision-free key for these fixtures, shared by the host call and store.
  function calculateDepositKey(hash, index) {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(index);
    return new Bytes(Buffer.concat([Buffer.from(hash), output]));
  }
  const byteArrayToBigint = (value) => integer(BigInt(`0x${Buffer.from(value).toString("hex")}`));
  const exportsByModule = {
    "../generated/Bridge/Bridge": {
      Bridge: { bind: () => ({
        try_deposits(id) {
          assert.ok(depositCalls.has(id.toString()), "deposit call must match this fixture's funding output");
          return depositCalls.get(id.toString());
        },
        // Deliberately expose the final block value, even for earlier events.
        // The historical divisor must be independent of this eth_call result.
        try_depositParameters() {
          parameterCalls++;
          return { reverted: false, value: { value1: integer(endOfBlockDivisor) } };
        },
      }) },
    },
    "@graphprotocol/graph-ts": {
      BigInt: GraphBigInt, Bytes,
      log: { warning: (...args) => warnings.push(args), info: () => {} },
    },
    "../generated/schema": { BridgeState, WalletSchemeChange },
    "./utils/helper": {
      getOrCreateDeposit: (id) => loadOrCreate(Deposit, id),
      getOrCreateTransaction: (id) => loadOrCreate(Transaction, id),
      getOrCreateUser: (id) => loadOrCreate(User, id),
      getOrCreateTbtcToken: () => ({ id: "TBTCToken" }),
      getStats: () => loadOrCreate(Stats, "singleton"),
    },
    "./utils/utils": {
      bytesToUint8Array: (value) => new Uint8Array(value),
      calculateDepositKey, byteArrayToBigint,
      getIDFromEvent: (event) => `${event.transaction.hash.toHexString()}-${event.logIndex}`,
    },
    "./utils/constants": { ZERO_BI: integer(0), ONE_BI: integer(1) },
    "./swept": {},
    "./utils/bitcoin_utils": {},
  };

  // Type stripping preserves imports. Give imported type-only bindings strict
  // placeholders rather than maintaining a duplicate list of Bridge events.
  // Handler bodies are neither extracted nor rewritten.
  for (const match of mappingSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const [, bindings, specifier] = match;
    assert.ok(Object.hasOwn(exportsByModule, specifier), `Unknown mapping dependency: ${specifier}`);
    for (const binding of bindings.split(",")) {
      const name = binding.trim().split(/\s+as\s+/)[0];
      if (name && !Object.hasOwn(exportsByModule[specifier], name)) {
        exportsByModule[specifier][name] = unexpected(`${specifier}:${name}`);
      }
    }
  }
  const context = createContext({ Uint8Array });
  const mapping = new SourceTextModule(stripTypeScriptTypes(mappingSource), {
    context, identifier: mappingPath.href,
  });
  await mapping.link((specifier) => {
    assert.ok(Object.hasOwn(exportsByModule, specifier), `Unknown mapping dependency: ${specifier}`);
    const values = exportsByModule[specifier];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await mapping.evaluate();
  const handlers = mapping.namespace;

  function event(params) {
    sequence++;
    return {
      params, address: bytes(1, 20), logIndex: integer(sequence),
      block: { number: integer(20_000_000), timestamp: integer(1_700_000_000) },
      transaction: { hash: bytes(sequence), from: bytes(2, 20), to: bytes(1, 20) },
    };
  }
  return {
    handlers, event, bytes, warnings,
    state: () => BridgeState.load("singleton"),
    deposit: (id) => Deposit.load(id),
    stats: () => Stats.load("singleton"),
    parameterCalls: () => parameterCalls,
    initialize: (version = 1) => handlers.handleInitialized(event({ version })),
    update: (divisor) => handlers.handleDepositParametersUpdated(event({
      depositDustThreshold: integer(1000), depositTreasuryFeeDivisor: integer(divisor),
      depositTxMaxFee: integer(100), depositRevealAheadPeriod: 0,
    })),
    reveal({ fee = 0, reverted = false } = {}) {
      const reveal = event({
        fundingTxHash: bytes(sequence + 100), fundingOutputIndex: integer(0),
        depositor: bytes(2, 20), amount: integer(10_000), walletPubKeyHash: bytes(3, 20),
        blindingFactor: bytes(4, 8), refundPubKeyHash: bytes(5, 20),
        refundLocktime: bytes(6, 4), vault: bytes(7, 20),
      });
      const id = calculateDepositKey(reveal.params.fundingTxHash, 0);
      depositCalls.set(byteArrayToBigint(id).toString(), {
        reverted, value: { treasuryFee: integer(fee) },
      });
      handlers.handleDepositRevealed(reveal);
      return Deposit.load(id);
    },
  };
}
