import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { assert, beforeEach, clearStore, newMockEvent, test } from "matchstick-as/assembly/index"
import {
    Staked, UnstakeStarted, UnstakeFinished, RebateReceived, RebateCanceled, TransferFinished,
} from "../generated/RebateStaking/RebateStaking"
import {
    handleStaked, handleUnstakeStarted, handleUnstakeFinished,
    handleRebateReceived, handleRebateCanceled, handleTransferFinished,
} from "../src/mappingRebateStaking"

const ALICE = Address.fromString("0x1111111111111111111111111111111111111111")
const BOB = Address.fromString("0x2222222222222222222222222222222222222222")

function amountEvent(staker: Address, amount: string, logIndex: i32, parameter: string = "amount"): ethereum.Event {
    let event = newMockEvent()
    event.logIndex = BigInt.fromI32(logIndex)
    event.block.number = BigInt.fromI32(23598705)
    event.block.timestamp = BigInt.fromI32(1700000000 + logIndex)
    event.parameters = [
        new ethereum.EventParam("staker", ethereum.Value.fromAddress(staker)),
        new ethereum.EventParam(parameter, ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amount))),
    ]
    return event
}

function eventId(event: ethereum.Event, staker: Bytes): string {
    return event.transaction.hash.concatI32(event.logIndex.toI32()).concat(staker).toHexString()
}

beforeEach(() => { clearStore() })

test("pending unstake replaces the request and stays in getStake until finalized", () => {
    handleStaked(changetype<Staked>(amountEvent(ALICE, "100000000000000000000", 1)))
    handleStaked(changetype<Staked>(amountEvent(ALICE, "50000000000000000000", 2)))
    handleUnstakeStarted(changetype<UnstakeStarted>(amountEvent(ALICE, "50000000000000000000", 3)))
    handleUnstakeStarted(changetype<UnstakeStarted>(amountEvent(ALICE, "30000000000000000000", 4)))
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "stakedAmount", "150000000000000000000")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "pendingUnstakeAmount", "30000000000000000000")
    assert.fieldEquals("RebateStakingStats", "global", "totalStaked", "150000000000000000000")
    handleUnstakeFinished(changetype<UnstakeFinished>(amountEvent(ALICE, "30000000000000000000", 5)))
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "stakedAmount", "120000000000000000000")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "pendingUnstakeAmount", "0")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "firstStakedAt", "1700000001")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "lastStakedAt", "1700000002")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "eventCount", "5")
    assert.fieldEquals("RebateStakingStats", "global", "totalStaked", "120000000000000000000")
    assert.fieldEquals("RebateStakingStats", "global", "activeStakers", "1")
})

test("fully unstaking and restaking changes active count without counting a new address", () => {
    handleStaked(changetype<Staked>(amountEvent(ALICE, "100", 1)))
    handleStaked(changetype<Staked>(amountEvent(BOB, "200", 2)))
    handleUnstakeStarted(changetype<UnstakeStarted>(amountEvent(ALICE, "100", 3)))
    handleUnstakeFinished(changetype<UnstakeFinished>(amountEvent(ALICE, "100", 4)))
    assert.fieldEquals("RebateStakingStats", "global", "activeStakers", "1")
    assert.fieldEquals("RebateStakingStats", "global", "totalStaked", "200")
    handleStaked(changetype<Staked>(amountEvent(ALICE, "50", 5)))
    assert.fieldEquals("RebateStakingStats", "global", "totalStakers", "2")
    assert.fieldEquals("RebateStakingStats", "global", "activeStakers", "2")
    assert.fieldEquals("RebateStakingStats", "global", "totalStaked", "250")
})

test("multiple rebates in one transaction retain separate records and satoshi totals", () => {
    let first = changetype<RebateReceived>(amountEvent(ALICE, "70000", 1, "rebate"))
    let second = changetype<RebateReceived>(amountEvent(ALICE, "80000", 2, "rebate"))
    handleRebateReceived(first)
    handleRebateReceived(second)
    assert.entityCount("RebateStakingEvent", 2)
    assert.fieldEquals("RebateStakingEvent", eventId(first, ALICE), "amount", "70000")
    assert.fieldEquals("RebateStakingEvent", eventId(second, ALICE), "amount", "80000")
    assert.fieldEquals("RebateStakingEvent", eventId(second, ALICE), "sequence", "101355666202951682")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "rebateCount", "2")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "totalRebatesReceived", "150000")
    assert.fieldEquals("RebateStakingStats", "global", "totalRebatesDistributed", "150000")
    assert.fieldEquals("RebateStakingStats", "global", "activeStakers", "0")
})

test("cancellation records requestedAt without erasing lifetime awards", () => {
    handleRebateReceived(changetype<RebateReceived>(amountEvent(ALICE, "70000", 1, "rebate")))
    let canceled = changetype<RebateCanceled>(amountEvent(ALICE, "1699999999", 2, "requestedAt"))
    handleRebateCanceled(canceled)
    assert.fieldEquals("RebateStakingEvent", eventId(canceled, ALICE), "eventType", "REBATE_CANCELED")
    assert.fieldEquals("RebateStakingEvent", eventId(canceled, ALICE), "requestedAt", "1699999999")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "totalRebatesReceived", "70000")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "rebateCount", "1")
    assert.fieldEquals("RebateStakingStats", "global", "totalRebatesDistributed", "70000")
})

test("transfer moves stake and pending request, preserves history, and emits both sides", () => {
    handleStaked(changetype<Staked>(amountEvent(ALICE, "1000", 1)))
    handleUnstakeStarted(changetype<UnstakeStarted>(amountEvent(ALICE, "300", 2)))
    handleRebateReceived(changetype<RebateReceived>(amountEvent(ALICE, "70000", 3, "rebate")))
    let transfer = changetype<TransferFinished>(newMockEvent())
    transfer.logIndex = BigInt.fromI32(4)
    transfer.block.timestamp = BigInt.fromI32(1700000004)
    transfer.parameters = [
        new ethereum.EventParam("oldStaker", ethereum.Value.fromAddress(ALICE)),
        new ethereum.EventParam("newStaker", ethereum.Value.fromAddress(BOB)),
    ]
    handleTransferFinished(transfer)
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "stakedAmount", "0")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "pendingUnstakeAmount", "0")
    assert.fieldEquals("RebateStaker", ALICE.toHexString(), "totalRebatesReceived", "70000")
    assert.fieldEquals("RebateStaker", BOB.toHexString(), "stakedAmount", "1000")
    assert.fieldEquals("RebateStaker", BOB.toHexString(), "pendingUnstakeAmount", "300")
    assert.fieldEquals("RebateStaker", BOB.toHexString(), "totalRebatesReceived", "0")
    assert.fieldEquals("RebateStaker", BOB.toHexString(), "firstStakedAt", "1700000001")
    assert.fieldEquals("RebateStakingStats", "global", "totalStaked", "1000")
    assert.fieldEquals("RebateStakingStats", "global", "activeStakers", "1")
    assert.fieldEquals("RebateStakingStats", "global", "totalStakers", "2")
    assert.fieldEquals("RebateStakingEvent", eventId(transfer, ALICE), "eventType", "TRANSFERRED_OUT")
    assert.fieldEquals("RebateStakingEvent", eventId(transfer, BOB), "eventType", "TRANSFERRED_IN")
    assert.entityCount("RebateStakingEvent", 5)
})
