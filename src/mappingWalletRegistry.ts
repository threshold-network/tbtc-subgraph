import {Address, BigInt, log} from "@graphprotocol/graph-ts"
import {
    WalletRegistry,
    AuthorizationDecreaseRequested,
    AuthorizationIncreased,
    DkgMaliciousResultSlashed,
    DkgParametersUpdated,
    DkgResultApproved,
    DkgResultChallenged,
    DkgResultSubmitted,
    DkgSeedTimedOut,
    InactivityClaimed,
    OperatorJoinedSortitionPool,
    OperatorRegistered,
    RandomBeaconUpgraded,
    RewardsWithdrawn,
    WalletOwnerUpdated,
    WalletClosed,
    WalletCreated
} from "../generated/WalletRegistry/WalletRegistry"
import {SortitionPool} from "../generated/SortitionPool/SortitionPool"

import {
    getOrCreateOperator,
    getOrCreateOperatorEvent,
    getOrCreateRandomBeaconGroup,
    getStats,
    getStatus
} from "./utils/helper"
import * as Const from "./utils/constants"
import {GroupPublicKey, RandomBeaconGroup, RandomBeaconGroupMembership} from "../generated/schema"
import {getBeaconGroupId, keccak256TwoString} from "./utils/utils"
import {DkgStarted, DkgStateLocked, DkgTimedOut, RandomBeacon} from "../generated/RandomBeacon/RandomBeacon"

export function handleAuthorizationDecreaseRequested(
    event: AuthorizationDecreaseRequested
): void {
    let operator = getOrCreateOperator(event.params.stakingProvider)
    operator.tBTCAuthorizedAmount = event.params.toAmount
    //minimum to authorize is 40k
    if (event.params.toAmount.le(BigInt.fromI32(40000 * 10 ^ 18))) {
        operator.tBTCAuthorized = false
    }
    let eventEntity = getOrCreateOperatorEvent(event, "DECREASE_AUTHORIZED_TBTC")
    eventEntity.amount = event.params.fromAmount.minus(event.params.toAmount)
    eventEntity.isRandomBeaconEvent = false
    eventEntity.save()
    //Add event info into operator
    let events = operator.events
    events.push(eventEntity.id)
    operator.events = events
    operator.save()

    let changeAmount = event.params.fromAmount.minus(event.params.toAmount)
    let stats = getStats()
    stats.totalTBTCAuthorizedAmount = stats.totalTBTCAuthorizedAmount.minus(changeAmount)
    stats.save()
}

export function handleAuthorizationIncreased(
    event: AuthorizationIncreased
): void {
    let eventEntity = getOrCreateOperatorEvent(event, "AUTHORIZED_TBTC")
    eventEntity.amount = event.params.toAmount.minus(event.params.fromAmount)
    eventEntity.isRandomBeaconEvent = false
    eventEntity.save()

    let operator = getOrCreateOperator(event.params.stakingProvider)
    operator.tBTCAuthorized = true
    operator.tBTCAuthorizedAmount = event.params.toAmount
    //Add event info into operator
    let events = operator.events
    events.push(eventEntity.id)
    operator.events = events
    operator.save()

    let changeAmount = event.params.toAmount.minus(event.params.fromAmount)
    let stats = getStats()
    stats.totalTBTCAuthorizedAmount = stats.totalTBTCAuthorizedAmount.plus(changeAmount)
    stats.save()
}

export function handleDkgMaliciousResultSlashed(
    event: DkgMaliciousResultSlashed
): void {
}


export function handleDkgResultChallenged(event: DkgResultChallenged): void {
    let status = getStatus()
    status.ecdsaState = "AWAITING_RESULT"
    status.challenger = event.params.challenger
    status.reason = event.params.reason
    status.save()
}

export function handleDkgResultApproved(event: DkgResultApproved): void {
    let status = getStatus()
    status.ecdsaState = "IDLE"
    status.save()
}

export function handleDkgTimedOut(event: DkgTimedOut): void {
    let status = getStatus()
    status.ecdsaState = "IDLE"
    status.save()
}

export function handleDkgResultSubmitted(event: DkgResultSubmitted): void {
    let group = getOrCreateRandomBeaconGroup(getBeaconGroupId(event.params.result.groupPubKey))
    if (group.createdAt == Const.ZERO_BI) {
        group.createdAt = event.block.timestamp
        group.createdAtBlock = event.block.number
        group.isWalletRegistry = true
    }

    let memberIds = event.params.result.members
    // Slot and member counts are known from the event even if enrichment fails.
    let uniqueMemberIds = new Set<string>()
    for (let i = 0; i < memberIds.length; i++) {
        uniqueMemberIds.add(memberIds[i].toString())
    }
    group.size = memberIds.length
    group.uniqueMemberCount = uniqueMemberIds.size

    let walletRegistry = WalletRegistry.bind(event.address)
    // Best effort, as in the RandomBeacon handler: a reverted read costs this
    // group its member list rather than halting the subgraph. Empty members
    // leaves the loops below with nothing to do; group and status still save.
    let members: Address[] = []
    let sortitionPoolCall = walletRegistry.try_sortitionPool()
    if (sortitionPoolCall.reverted) {
        log.warning(
            "handleDkgResultSubmitted: WalletRegistry.sortitionPool reverted at block {}; skipping member enrichment",
            [event.block.number.toString()]
        )
    } else {
        let sortitionPoolContract = SortitionPool.bind(sortitionPoolCall.value)
        let membersCall = sortitionPoolContract.try_getIDOperators(memberIds)
        if (membersCall.reverted) {
            log.warning(
                "handleDkgResultSubmitted: SortitionPool.getIDOperators reverted at block {}; skipping member enrichment",
                [event.block.number.toString()]
            )
        } else {
            members = membersCall.value
        }
    }

    let memberSeats: Map<string, i32[]> = new Map()
    let uniqueAddresses: string[] = []
    for (let i = 0; i < members.length; i++) {
        let memberAddress = members[i].toHexString()
        if (!memberSeats.has(memberAddress)) {
            uniqueAddresses.push(memberAddress)

            memberSeats.set(memberAddress, [i + 1])
        } else {
            let existingSeats = memberSeats.get(memberAddress)
            existingSeats.push(i + 1)
            memberSeats.set(memberAddress, existingSeats)
        }
    }

    for (let i = 0; i < uniqueAddresses.length; i++) {
        let memberAddress = uniqueAddresses[i]
        let stakingProviderCall = walletRegistry.try_operatorToStakingProvider(Address.fromString(memberAddress))
        if (stakingProviderCall.reverted) {
            log.warning(
                "handleDkgResultSubmitted: WalletRegistry.operatorToStakingProvider reverted for {} at block {}; skipping this member",
                [memberAddress, event.block.number.toString()]
            )
            continue
        }
        let stakingProvider = stakingProviderCall.value
        let operator = getOrCreateOperator(stakingProvider)
        operator.beaconGroupCount += 1
        operator.save()

        let membership = new RandomBeaconGroupMembership(keccak256TwoString(group.id, stakingProvider.toHex()))
        membership.group = group.id
        membership.operator = operator.id
        membership.count = memberSeats.get(memberAddress).length
        membership.groupCreatedAt = group.createdAt
        membership.seats = memberSeats.get(memberAddress)
        membership.save()

    }
    group.save()

    let groupPubKey = GroupPublicKey.load("ecdsa_" + event.transaction.hash.toHex())
    if (!groupPubKey) {
        groupPubKey = new GroupPublicKey("ecdsa_" + event.transaction.hash.toHex())
    }
    groupPubKey.group = group.id
    groupPubKey.pubKey = event.params.result.groupPubKey
    groupPubKey.save()

    let status = getStatus()
    status.ecdsaState = "CHALLENGE"
    status.save()
}

export function handleDkgSeedTimedOut(event: DkgSeedTimedOut): void {
    let status = getStatus()
    status.ecdsaState = "IDLE"
    status.save()
}

export function handleDkgStarted(event: DkgStarted): void {
    let status = getStatus()
    status.ecdsaState = "AWAITING_RESULT"
    status.save()
}

export function handleDkgStateLocked(event: DkgStateLocked): void {
    let status = getStatus()
    status.ecdsaState = "AWAITING_SEED"
    status.save()
}

export function handleInactivityClaimed(event: InactivityClaimed): void {

}

export function handleOperatorJoinedSortitionPool(
    event: OperatorJoinedSortitionPool
): void {
    let eventEntity = getOrCreateOperatorEvent(event, "JOINED_SORTITION_POOL")
    eventEntity.isRandomBeaconEvent = false
    eventEntity.save()

    let operator = getOrCreateOperator(event.params.stakingProvider)
    let events = operator.events
    events.push(eventEntity.id)
    operator.events = events
    operator.address = event.params.operator
    operator.save()
}

export function handleOperatorRegistered(event: OperatorRegistered): void {
    let operator = getOrCreateOperator(event.params.stakingProvider)
    if (operator.stakedAt != Const.ZERO_BI && operator.stakedAmount != Const.ZERO_BI) {
        let eventEntity = getOrCreateOperatorEvent(event, "REGISTERED_OPERATOR")
        eventEntity.isRandomBeaconEvent = false
        eventEntity.save()

        operator.address = event.params.operator
        operator.registeredOperatorAddress += 1
        let events = operator.events
        events.push(eventEntity.id)
        operator.events = events
        operator.save()

        if (!operator.isBondRegisteredOperatorAddress && operator.registeredOperatorAddress == 2) {
            let stats = getStats()
            stats.numOperatorsRegisteredNode += 1
            stats.save()
        }
    }
}

export function handleRewardsWithdrawn(event: RewardsWithdrawn): void {
    let eventEntity = getOrCreateOperatorEvent(event, "WITHDRAW_REWARD")
    eventEntity.amount = event.params.amount
    eventEntity.isRandomBeaconEvent = false
    eventEntity.save()

    let randomContract = RandomBeacon.bind(event.address)
    let availableRewardCall = randomContract.try_availableRewards(event.params.stakingProvider)

    let operator = getOrCreateOperator(event.params.stakingProvider)
    // The withdrawn amount comes from the event, so the running total stays
    // correct even when the remaining-balance read is unavailable.
    operator.rewardDispensed = operator.rewardDispensed.plus(event.params.amount)
    if (availableRewardCall.reverted) {
        log.warning(
            "handleRewardsWithdrawn: RandomBeacon.availableRewards reverted for {} at block {}; keeping the previous balance",
            [event.params.stakingProvider.toHexString(), event.block.number.toString()]
        )
    } else {
        operator.availableReward = availableRewardCall.value
    }

    let events = operator.events
    events.push(eventEntity.id)
    operator.events = events

    operator.save()
}

export function handleWalletOwnerUpdated(event: WalletOwnerUpdated): void {
}

export function handleWalletClosed(event: WalletClosed): void {
}

export function handleWalletCreated(event: WalletCreated): void {
}

