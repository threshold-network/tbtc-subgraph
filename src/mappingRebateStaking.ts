import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
    Staked, UnstakeStarted, UnstakeFinished, RebateReceived,
    RebateCanceled, TransferFinished,
} from "../generated/RebateStaking/RebateStaking"
import { RebateStaker, RebateStakingEvent, RebateStakingStats } from "../generated/schema"

const ZERO = BigInt.fromI32(0)

function getStats(): RebateStakingStats {
    let stats = RebateStakingStats.load("global")
    if (stats == null) {
        stats = new RebateStakingStats("global")
        stats.totalStakers = 0
        stats.activeStakers = 0
        stats.totalStaked = ZERO
        stats.totalRebatesDistributed = ZERO
    }
    return stats
}

function getStaker(address: Bytes): RebateStaker {
    let staker = RebateStaker.load(address)
    if (staker == null) {
        staker = new RebateStaker(address)
        staker.stakedAmount = ZERO
        staker.pendingUnstakeAmount = ZERO
        staker.totalRebatesReceived = ZERO
        staker.rebateCount = 0
        staker.eventCount = 0
        staker.save()
        let stats = getStats()
        stats.totalStakers += 1
        stats.save()
    }
    return staker
}

function saveBalance(staker: RebateStaker, previousAmount: BigInt): void {
    let stats = getStats()
    stats.totalStaked = stats.totalStaked.plus(staker.stakedAmount).minus(previousAmount)
    if (previousAmount.equals(ZERO) && staker.stakedAmount.gt(ZERO)) {
        stats.activeStakers += 1
    } else if (previousAmount.gt(ZERO) && staker.stakedAmount.equals(ZERO)) {
        stats.activeStakers -= 1
    }
    stats.save()
    staker.save()
}

function recordEvent(
    event: ethereum.Event,
    staker: RebateStaker,
    eventType: string,
    amount: BigInt | null,
    requestedAt: BigInt | null = null,
): void {
    let id = event.transaction.hash.concatI32(event.logIndex.toI32()).concat(staker.id)
    let record = new RebateStakingEvent(id)
    record.staker = staker.id
    record.eventType = eventType
    record.amount = amount
    record.blockNumber = event.block.number
    record.timestamp = event.block.timestamp
    record.transactionHash = event.transaction.hash
    record.sequence = event.block.number.leftShift(32).plus(event.logIndex)
    record.requestedAt = requestedAt
    record.save()
    staker.eventCount += 1
    staker.save()
}

export function handleStaked(event: Staked): void {
    let staker = getStaker(event.params.staker)
    let previousAmount = staker.stakedAmount
    staker.stakedAmount = previousAmount.plus(event.params.amount)
    if (!staker.firstStakedAt) staker.firstStakedAt = event.block.timestamp
    staker.lastStakedAt = event.block.timestamp
    saveBalance(staker, previousAmount)
    recordEvent(event, staker, "STAKED", event.params.amount)
}

export function handleUnstakeStarted(event: UnstakeStarted): void {
    let staker = getStaker(event.params.staker)
    // startUnstaking replaces the pending request. It does not remove stake;
    // getStake still includes it until finalizeUnstaking emits UnstakeFinished.
    staker.pendingUnstakeAmount = event.params.amount
    recordEvent(event, staker, "UNSTAKE_STARTED", event.params.amount)
}

export function handleUnstakeFinished(event: UnstakeFinished): void {
    let staker = getStaker(event.params.staker)
    let previousAmount = staker.stakedAmount
    staker.stakedAmount = previousAmount.minus(event.params.amount)
    staker.pendingUnstakeAmount = ZERO
    saveBalance(staker, previousAmount)
    recordEvent(event, staker, "UNSTAKE_FINISHED", event.params.amount)
}

export function handleRebateReceived(event: RebateReceived): void {
    let staker = getStaker(event.params.staker)
    staker.totalRebatesReceived = staker.totalRebatesReceived.plus(event.params.rebate)
    staker.rebateCount += 1
    let stats = getStats()
    stats.totalRebatesDistributed = stats.totalRebatesDistributed.plus(event.params.rebate)
    stats.save()
    recordEvent(event, staker, "REBATE_RECEIVED", event.params.rebate)
}

export function handleRebateCanceled(event: RebateCanceled): void {
    let staker = getStaker(event.params.staker)
    // Keep lifetime award totals consistent with the previous REST API.
    // Cancellation restores rolling-window eligibility, not historical awards.
    recordEvent(event, staker, "REBATE_CANCELED", null, event.params.requestedAt)
}

export function handleTransferFinished(event: TransferFinished): void {
    let oldStaker = getStaker(event.params.oldStaker)
    let newStaker = getStaker(event.params.newStaker)
    let transferredAmount = oldStaker.stakedAmount
    let previousNewAmount = newStaker.stakedAmount
    newStaker.stakedAmount = transferredAmount
    newStaker.pendingUnstakeAmount = oldStaker.pendingUnstakeAmount
    if (!newStaker.firstStakedAt) newStaker.firstStakedAt = oldStaker.firstStakedAt
    newStaker.lastStakedAt = event.block.timestamp
    oldStaker.stakedAmount = ZERO
    oldStaker.pendingUnstakeAmount = ZERO
    // Historical awards stay attributed to the address that received them.
    saveBalance(oldStaker, transferredAmount)
    saveBalance(newStaker, previousNewAmount)
    recordEvent(event, oldStaker, "TRANSFERRED_OUT", transferredAmount)
    recordEvent(event, newStaker, "TRANSFERRED_IN", transferredAmount)
}
