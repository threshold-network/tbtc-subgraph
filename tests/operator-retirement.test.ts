import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { assert, beforeEach, clearStore, createMockedFunction, newMockEvent, test } from "matchstick-as/assembly/index"
import {
    AuthorizationDecreaseRequested as WalletDecrease, AuthorizationIncreased as WalletIncrease,
    DkgResultSubmitted as WalletDkg, OperatorJoinedSortitionPool as WalletJoined,
    OperatorRegistered as WalletRegistered, RewardsWithdrawn as WalletReward,
} from "../generated/WalletRegistry/WalletRegistry"
import {
    AuthorizationDecreaseRequested as BeaconDecrease, AuthorizationIncreased as BeaconIncrease,
    DkgResultSubmitted as BeaconDkg, GroupRegistered, OperatorJoinedSortitionPool as BeaconJoined,
    OperatorRegistered as BeaconRegistered, RewardsWithdrawn as BeaconReward, UnauthorizedSigningSlashed,
} from "../generated/RandomBeacon/RandomBeacon"
import { TokensSeized } from "../generated/TokenStakingTelemetry/TokenStakingTelemetry"
import * as wallet from "../src/mappingWalletRegistry"
import * as beacon from "../src/mappingRandomBeacon"
import { handleTokensSeized } from "../src/mappingTokenStakingTelemetry"
import { Operator, RandomBeaconGroupMembership } from "../generated/schema"
import { getBeaconGroupId, getIDFromEvent, keccak256TwoString } from "../src/utils/utils"

const PROVIDER = Address.fromString("0x1111111111111111111111111111111111111111")
const OTHER = Address.fromString("0x2222222222222222222222222222222222222222")
const WALLET_OPERATOR = Address.fromString("0x3333333333333333333333333333333333333333")
const BEACON_OPERATOR = Address.fromString("0x4444444444444444444444444444444444444444")
const WALLET = Address.fromString("0x5555555555555555555555555555555555555555")
const BEACON = Address.fromString("0x6666666666666666666666666666666666666666")
const TOKEN_STAKING = Address.fromString("0x7777777777777777777777777777777777777777")
const POOL = Address.fromString("0x8888888888888888888888888888888888888888")
const PUBKEY = Bytes.fromHexString("0x1234567890123456789012345678901234567890123456789012345678901234")

function uint(value: string): ethereum.Value {
    return ethereum.Value.fromUnsignedBigInt(BigInt.fromString(value))
}

function event(contract: Address, index: i32): ethereum.Event {
    let result = newMockEvent()
    result.address = contract
    result.logIndex = BigInt.fromI32(index)
    result.block.timestamp = BigInt.fromI32(1700000000 + index)
    result.block.number = BigInt.fromI32(25000000 + index)
    return result
}

function registration(contract: Address, operator: Address, index: i32): ethereum.Event {
    let result = event(contract, index)
    result.parameters = [
        new ethereum.EventParam("stakingProvider", ethereum.Value.fromAddress(PROVIDER)),
        new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
    ]
    return result
}

function authorization(contract: Address, from: string, to: string, index: i32, provider: Address = PROVIDER): ethereum.Event {
    let result = event(contract, index)
    result.parameters = [
        new ethereum.EventParam("stakingProvider", ethereum.Value.fromAddress(provider)),
        new ethereum.EventParam("operator", ethereum.Value.fromAddress(WALLET_OPERATOR)),
        new ethereum.EventParam("fromAmount", uint(from)),
        new ethereum.EventParam("toAmount", uint(to)),
        new ethereum.EventParam("decreasingAt", uint("1700001000")),
    ]
    return result
}

function seizure(index: i32): TokensSeized {
    let result = event(TOKEN_STAKING, index)
    result.parameters = [
        new ethereum.EventParam("stakingProvider", ethereum.Value.fromAddress(PROVIDER)),
        new ethereum.EventParam("amount", uint("100000000000000000000")),
        new ethereum.EventParam("discrepancy", ethereum.Value.fromBoolean(true)),
    ]
    return changetype<TokensSeized>(result)
}

function groupRegistered(index: i32): GroupRegistered {
    let result = event(BEACON, index)
    result.parameters = [
        new ethereum.EventParam("groupId", uint("7")),
        new ethereum.EventParam("groupPubKey", ethereum.Value.fromBytes(PUBKEY)),
    ]
    return changetype<GroupRegistered>(result)
}

function dkg(contract: Address, index: i32): ethereum.Event {
    let memberIds = [BigInt.fromI32(1), BigInt.fromI32(2), BigInt.fromI32(1)]
    createMockedFunction(contract, "sortitionPool", "sortitionPool():(address)")
        .returns([ethereum.Value.fromAddress(POOL)])
    createMockedFunction(POOL, "getIDOperators", "getIDOperators(uint32[]):(address[])")
        .withArgs([ethereum.Value.fromUnsignedBigIntArray(memberIds)])
        .returns([ethereum.Value.fromAddressArray([WALLET_OPERATOR, BEACON_OPERATOR, WALLET_OPERATOR])])
    createMockedFunction(contract, "operatorToStakingProvider", "operatorToStakingProvider(address):(address)")
        .withArgs([ethereum.Value.fromAddress(WALLET_OPERATOR)]).returns([ethereum.Value.fromAddress(PROVIDER)])
    createMockedFunction(contract, "operatorToStakingProvider", "operatorToStakingProvider(address):(address)")
        .withArgs([ethereum.Value.fromAddress(BEACON_OPERATOR)]).returns([ethereum.Value.fromAddress(OTHER)])
    let tuple = new ethereum.Tuple()
    tuple.push(uint("1"))
    tuple.push(ethereum.Value.fromBytes(PUBKEY))
    tuple.push(ethereum.Value.fromI32Array([]))
    tuple.push(ethereum.Value.fromBytes(Bytes.empty()))
    tuple.push(ethereum.Value.fromUnsignedBigIntArray([]))
    tuple.push(ethereum.Value.fromUnsignedBigIntArray(memberIds))
    tuple.push(ethereum.Value.fromBytes(PUBKEY))
    let result = event(contract, index)
    result.parameters = [
        new ethereum.EventParam("resultHash", ethereum.Value.fromBytes(PUBKEY)),
        new ethereum.EventParam("seed", uint("1")),
        new ethereum.EventParam("result", ethereum.Value.fromTuple(tuple)),
    ]
    return result
}

function checkMembership(firstSeat: i32, secondSeat: i32): void {
    let group = getBeaconGroupId(PUBKEY)
    let id = keccak256TwoString(group, PROVIDER.toHexString())
    assert.fieldEquals("RandomBeaconGroup", group, "size", "3")
    assert.fieldEquals("RandomBeaconGroup", group, "uniqueMemberCount", "2")
    assert.fieldEquals("RandomBeaconGroupMembership", id, "operator", PROVIDER.toHexString())
    assert.fieldEquals("RandomBeaconGroupMembership", id, "count", "2")
    let membership = RandomBeaconGroupMembership.load(id)!
    assert.i32Equals(membership.seats[0], firstSeat)
    assert.i32Equals(membership.seats[1], secondSeat)
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "beaconGroupCount", "1")
    assert.entityCount("Operator", 2)
}

function reward(contract: Address, amount: string, index: i32): ethereum.Event {
    createMockedFunction(contract, "availableRewards", "availableRewards(address):(uint96)")
        .withArgs([ethereum.Value.fromAddress(PROVIDER)]).returns([uint("9")])
    let result = event(contract, index)
    result.parameters = [
        new ethereum.EventParam("stakingProvider", ethereum.Value.fromAddress(PROVIDER)),
        new ethereum.EventParam("amount", uint(amount)),
    ]
    return result
}

beforeEach(() => { clearStore() })

test("wallet registration creates an operator without any stake event", () => {
    let registered = changetype<WalletRegistered>(registration(WALLET, WALLET_OPERATOR, 1))
    wallet.handleOperatorRegistered(registered)
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "address", WALLET_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "walletRegistryOperator", WALLET_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "registeredAt", "1700000001")
    assert.fieldEquals("Event", getIDFromEvent(registered), "event", "REGISTERED_OPERATOR")
    assert.fieldEquals("Event", getIDFromEvent(registered), "contract", WALLET.toHexString())
    assert.fieldEquals("Event", getIDFromEvent(registered), "isRandomBeaconEvent", "false")
    assert.entityCount("StatsRecord", 0)
})

test("beacon registration creates an operator without any stake event", () => {
    let registered = changetype<BeaconRegistered>(registration(BEACON, BEACON_OPERATOR, 1))
    beacon.handleOperatorRegistered(registered)
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "randomBeaconOperator", BEACON_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "registeredAt", "1700000001")
    assert.fieldEquals("Event", getIDFromEvent(registered), "isRandomBeaconEvent", "true")
    assert.entityCount("StatsRecord", 0)
})

test("re-registration preserves application identities, first registration time, and earlier telemetry", () => {
    handleTokensSeized(seizure(1))
    wallet.handleOperatorRegistered(changetype<WalletRegistered>(registration(WALLET, WALLET_OPERATOR, 2)))
    beacon.handleOperatorRegistered(changetype<BeaconRegistered>(registration(BEACON, BEACON_OPERATOR, 3)))
    wallet.handleOperatorRegistered(changetype<WalletRegistered>(registration(WALLET, OTHER, 4)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "walletRegistryOperator", OTHER.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "randomBeaconOperator", BEACON_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "registeredAt", "1700000002")
    assert.i32Equals(Operator.load(PROVIDER.toHexString())!.events.length, 4)
    assert.entityCount("Operator", 1)
    assert.entityCount("StatsRecord", 0)
})

test("pool joins retain both application identities without stake or registration records", () => {
    wallet.handleOperatorJoinedSortitionPool(changetype<WalletJoined>(registration(WALLET, WALLET_OPERATOR, 1)))
    beacon.handleOperatorJoinedSortitionPool(changetype<BeaconJoined>(registration(BEACON, BEACON_OPERATOR, 2)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "walletRegistryOperator", WALLET_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "randomBeaconOperator", BEACON_OPERATOR.toHexString())
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "address", BEACON_OPERATOR.toHexString())
    assert.i32Equals(Operator.load(PROVIDER.toHexString())!.events.length, 2)
})

test("wallet authorization accepts small weights and tracks positive and zero decrease requests", () => {
    wallet.handleAuthorizationIncreased(changetype<WalletIncrease>(authorization(WALLET, "0", "5", 1)))
    wallet.handleAuthorizationDecreaseRequested(changetype<WalletDecrease>(authorization(WALLET, "5", "2", 2)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "tBTCAuthorized", "true")
    assert.fieldEquals("StatsRecord", "current", "totalTBTCAuthorizationWeight", "2")
    wallet.handleAuthorizationDecreaseRequested(changetype<WalletDecrease>(authorization(WALLET, "5", "0", 3)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "tBTCAuthorized", "false")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "tBTCAuthorizationWeight", "0")
    assert.fieldEquals("StatsRecord", "current", "totalTBTCAuthorizationWeight", "0")
})

test("beacon authorization accepts small weights and clears authorization at zero", () => {
    beacon.handleAuthorizationIncreased(changetype<BeaconIncrease>(authorization(BEACON, "0", "4", 1)))
    beacon.handleAuthorizationDecreaseRequested(changetype<BeaconDecrease>(authorization(BEACON, "4", "1", 2)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "randomBeaconAuthorized", "true")
    assert.fieldEquals("StatsRecord", "current", "totalRandomBeaconAuthorizationWeight", "1")
    beacon.handleAuthorizationDecreaseRequested(changetype<BeaconDecrease>(authorization(BEACON, "4", "0", 3)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "randomBeaconAuthorized", "false")
    assert.fieldEquals("StatsRecord", "current", "totalRandomBeaconAuthorizationWeight", "0")
})

test("migration callbacks from zero replace old values without double counting either application", () => {
    wallet.handleAuthorizationIncreased(changetype<WalletIncrease>(authorization(WALLET, "0", "40000000000000000000000", 1)))
    wallet.handleAuthorizationIncreased(changetype<WalletIncrease>(authorization(WALLET, "0", "7", 2, OTHER)))
    beacon.handleAuthorizationIncreased(changetype<BeaconIncrease>(authorization(BEACON, "0", "40000000000000000000000", 3)))
    beacon.handleAuthorizationIncreased(changetype<BeaconIncrease>(authorization(BEACON, "0", "8", 4, OTHER)))
    wallet.handleAuthorizationIncreased(changetype<WalletIncrease>(authorization(WALLET, "0", "2", 5)))
    beacon.handleAuthorizationIncreased(changetype<BeaconIncrease>(authorization(BEACON, "0", "3", 6)))
    assert.fieldEquals("StatsRecord", "current", "totalTBTCAuthorizationWeight", "9")
    assert.fieldEquals("StatsRecord", "current", "totalRandomBeaconAuthorizationWeight", "11")
})

test("TokensSeized keeps raw telemetry and emitter without altering weights, rewards, or fault counters", () => {
    wallet.handleAuthorizationIncreased(changetype<WalletIncrease>(authorization(WALLET, "0", "2", 1)))
    wallet.handleRewardsWithdrawn(changetype<WalletReward>(reward(WALLET, "6", 2)))
    let seized = seizure(3)
    handleTokensSeized(seized)
    assert.fieldEquals("Event", getIDFromEvent(seized), "event", "SLASHED")
    assert.fieldEquals("Event", getIDFromEvent(seized), "amount", "100000000000000000000")
    assert.fieldEquals("Event", getIDFromEvent(seized), "contract", TOKEN_STAKING.toHexString())
    assert.fieldEquals("Event", getIDFromEvent(seized), "discrepancy", "true")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "tBTCAuthorizationWeight", "2")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "rewardDispensed", "6")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "availableReward", "9")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "misbehavedCount", "0")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "totalSlashedAmount", "0")
    assert.fieldEquals("StatsRecord", "current", "totalTBTCAuthorizationWeight", "2")
})

test("wallet DKG retains group public key and repeated membership seats without token staking", () => {
    let submitted = changetype<WalletDkg>(dkg(WALLET, 1))
    wallet.handleDkgResultSubmitted(submitted)
    checkMembership(1, 3)
    assert.fieldEquals("RandomBeaconGroup", getBeaconGroupId(PUBKEY), "isWalletRegistry", "true")
    assert.fieldEquals("GroupPublicKey", "ecdsa_" + submitted.transaction.hash.toHexString(), "pubKey", PUBKEY.toHexString())
    assert.fieldEquals("GroupPublicKey", "ecdsa_" + submitted.transaction.hash.toHexString(), "group", getBeaconGroupId(PUBKEY))
})

test("beacon DKG retains group public key and repeated membership seats without token staking", () => {
    beacon.handleDkgResultSubmitted(changetype<BeaconDkg>(dkg(BEACON, 1)))
    beacon.handleGroupRegistered(groupRegistered(2))
    checkMembership(0, 2)
    assert.fieldEquals("GroupPublicKey", "7", "group", getBeaconGroupId(PUBKEY))
    assert.fieldEquals("GroupPublicKey", "7", "pubKey", PUBKEY.toHexString())
})

test("application faults retain group and operator counters without double counting TokensSeized", () => {
    beacon.handleGroupRegistered(groupRegistered(1))
    let fault = event(BEACON, 2)
    fault.parameters = [
        new ethereum.EventParam("groupId", uint("7")),
        new ethereum.EventParam("unauthorizedSigningSlashingAmount", uint("100000000000000000000")),
        new ethereum.EventParam("groupMembers", ethereum.Value.fromAddressArray([PROVIDER])),
    ]
    beacon.handleUnauthorizedSigningSlashed(changetype<UnauthorizedSigningSlashed>(fault))
    handleTokensSeized(seizure(3))
    assert.fieldEquals("RandomBeaconGroup", getBeaconGroupId(PUBKEY), "misbehavedCount", "1")
    assert.fieldEquals("RandomBeaconGroup", getBeaconGroupId(PUBKEY), "terminated", "true")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "misbehavedCount", "1")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "totalSlashedAmount", "100000000000000000000")
    assert.i32Equals(Operator.load(PROVIDER.toHexString())!.events.length, 2)
    assert.entityCount("Event", 2)
})

test("reward withdrawal history remains available without token staking", () => {
    wallet.handleRewardsWithdrawn(changetype<WalletReward>(reward(WALLET, "6", 1)))
    beacon.handleRewardsWithdrawn(changetype<BeaconReward>(reward(BEACON, "4", 2)))
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "rewardDispensed", "10")
    assert.fieldEquals("Operator", PROVIDER.toHexString(), "availableReward", "9")
    assert.i32Equals(Operator.load(PROVIDER.toHexString())!.events.length, 2)
})
