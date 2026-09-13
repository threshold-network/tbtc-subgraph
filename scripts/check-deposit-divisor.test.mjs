import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeHarness } from "./bridge-mapping-harness.mjs";

const divisor = (deposit) => deposit.treasuryFeeDivisorAtReveal?.toString() ?? null;
const stateDivisor = (harness) => harness.state()?.depositTreasuryFeeDivisor?.toString() ?? null;

test("Initialized(1) seeds the first reveal with the Bridge's historical 2000 divisor", async () => {
  const h = await createBridgeHarness({ endOfBlockDivisor: 500 });
  h.initialize();
  const deposit = h.reveal({ fee: 5 });
  assert.equal(divisor(deposit), "2000");
  assert.equal(deposit.treasuryFee.toString(), "5");
  assert.equal(deposit.status, "REVEALED");
  assert.equal(deposit.transactions.length, 1);
  assert.equal(h.stats().numDeposits, 1);
  assert.equal(h.parameterCalls(), 0);
  assert.equal(h.warnings.length, 0);
});

for (const [before, after] of [[0, 500], [500, 0]]) {
  test(`reveal/update/reveal in one block preserves divisor ${before} then ${after}`, async () => {
    const h = await createBridgeHarness({ endOfBlockDivisor: after });
    h.initialize();
    h.update(before);
    const first = h.reveal();
    h.update(after);
    const second = h.reveal();
    assert.equal(divisor(first), String(before));
    assert.equal(divisor(second), String(after));
    assert.equal(divisor(h.deposit(first.id)), String(before), "later updates cannot rewrite the earlier deposit");
    assert.equal(first.treasuryFee.toString(), "0");
    assert.equal(second.treasuryFee.toString(), "0");
    assert.equal(stateDivisor(h), String(after));
    assert.equal(h.parameterCalls(), 0);
  });
}

test("successive updates apply before each reveal and retain earlier deposit snapshots", async () => {
  const h = await createBridgeHarness({ endOfBlockDivisor: 250 });
  h.initialize();
  h.update(0);
  h.update(500);
  const charged = h.reveal({ fee: 20 });
  const waived = h.reveal();
  h.update(1000);
  const next = h.reveal({ fee: 10 });
  h.update(250);
  assert.equal(divisor(charged), "500");
  assert.equal(divisor(waived), "500");
  assert.equal(divisor(next), "1000");
  assert.equal(charged.treasuryFee.toString(), "20");
  assert.equal(waived.treasuryFee.toString(), "0");
  assert.equal(next.treasuryFee.toString(), "10");
  assert.equal(divisor(h.deposit(charged.id)), "500");
  assert.equal(stateDivisor(h), "250");
  assert.equal(h.parameterCalls(), 0);
});

test("missing initialization stays unknown until an event supplies the divisor", async () => {
  const h = await createBridgeHarness();
  const unknown = h.reveal();
  assert.equal(divisor(unknown), null);
  assert.equal(stateDivisor(h), null);
  assert.equal(h.warnings.length, 1);
  h.initialize(2);
  assert.equal(divisor(h.reveal()), null, "a later reinitializer does not imply a historical default");
  h.update(0);
  assert.equal(divisor(h.reveal()), "0", "known zero differs from missing history");
  assert.equal(divisor(h.deposit(unknown.id)), null, "new state cannot backfill an unknown earlier reveal");
  assert.equal(h.parameterCalls(), 0);
});

for (const value of [0, 500]) {
  test(`initialization and reinitialization preserve an already tracked divisor of ${value}`, async () => {
    const h = await createBridgeHarness();
    h.update(value);
    h.initialize();
    h.initialize(2);
    assert.equal(stateDivisor(h), String(value));
    assert.equal(divisor(h.reveal()), String(value));
  });
}

test("parameter tracking preserves unrelated BridgeState fields", async () => {
  const h = await createBridgeHarness();
  const router = h.bytes(42, 20);
  h.handlers.handleLifecycleRouterSet(h.event({ lifecycleRouter: router }));
  h.handlers.handleNewWalletSchemeSet(h.event({ scheme: 1 }));
  h.initialize();
  assert.equal(stateDivisor(h), "2000", "seed an existing singleton whose divisor is unknown");
  h.update(500);
  h.initialize(2);
  const state = h.state();
  assert.equal(state.currentScheme, "FROST");
  assert.equal(state.lifecycleRouter.toHexString(), router.toHexString());
  assert.equal(stateDivisor(h), "500");
});

test("an unreadable legacy deposit record does not prevent the historical divisor snapshot", async () => {
  const h = await createBridgeHarness();
  h.initialize();
  const deposit = h.reveal({ reverted: true });
  assert.equal(divisor(deposit), "2000");
  assert.equal(deposit.treasuryFee.toString(), "0");
  assert.equal(h.warnings.length, 1);
  assert.equal(h.parameterCalls(), 0);
});
