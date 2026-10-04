import {
    SortitionPool,
    BetaOperatorsAdded as BetaOperatorsAddedEvent,
    ChaosnetDeactivated as ChaosnetDeactivatedEvent,
    ChaosnetOwnerRoleTransferred as ChaosnetOwnerRoleTransferredEvent,
    IneligibleForRewards as IneligibleForRewardsEvent,
    OwnershipTransferred as OwnershipTransferredEvent,
    RewardEligibilityRestored as RewardEligibilityRestoredEvent
} from "../generated/SortitionPool/SortitionPool"
import {} from "../generated/schema"
import {log} from "@graphprotocol/graph-ts"
import * as Const from "./utils/constants"

import {
    getOrCreateOperator,
} from "./utils/helper"

export function handleBetaOperatorsAdded(event: BetaOperatorsAddedEvent): void {

}

export function handleChaosnetDeactivated(
    event: ChaosnetDeactivatedEvent
): void {

}

export function handleChaosnetOwnerRoleTransferred(
    event: ChaosnetOwnerRoleTransferredEvent
): void {

}

/*
Called when operator has misbehaved
 */
export function handleIneligibleForRewards(
    event: IneligibleForRewardsEvent
): void {
    let memberIds = event.params.ids
    let sortitionContract = SortitionPool.bind(event.address)
    // Without the operator list there is nothing to attribute the ban to, so
    // skip the event rather than abort the mapping and halt the subgraph.
    let memberAddressesCall = sortitionContract.try_getIDOperators(memberIds)
    if (memberAddressesCall.reverted) {
        log.warning(
            "handleIneligibleForRewards: SortitionPool.getIDOperators reverted at block {}; skipping this event",
            [event.block.number.toString()]
        )
        return
    }
    let memberAddresses = memberAddressesCall.value
    for (let i = 0; i < memberAddresses.length; i++) {
        let operator = getOrCreateOperator(memberAddresses[i])
        // The ban itself comes from the event, so it is still recorded when the
        // balance read is unavailable; only the balance keeps its old value.
        let rewardsCall = sortitionContract.try_getAvailableRewards(memberAddresses[i])
        if (rewardsCall.reverted) {
            log.warning(
                "handleIneligibleForRewards: SortitionPool.getAvailableRewards reverted for {} at block {}; keeping the previous balance",
                [memberAddresses[i].toHexString(), event.block.number.toString()]
            )
        } else {
            operator.availableReward = rewardsCall.value
        }
        operator.misbehavedCount += 1
        operator.poolRewardBanDuration = event.params.until
        operator.save()
    }
}

export function handleOwnershipTransferred(
    event: OwnershipTransferredEvent
): void {

}

export function handleRewardEligibilityRestored(
    event: RewardEligibilityRestoredEvent
): void {
    let operator = getOrCreateOperator(event.params.operator)
    operator.poolRewardBanDuration = Const.ZERO_BI
    operator.save()
}
