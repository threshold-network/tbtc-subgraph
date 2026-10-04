import {Address, BigInt, Bytes, ethereum} from '@graphprotocol/graph-ts'
import {
    Deposit,
    Redemption,
    Transaction,
    Event,
    User,
    TBTCToken,
    Operator,
    StatsRecord,
    StatusRecord, RandomBeaconGroup
} from "../../generated/schema"
import * as constants from "./constants"
import * as Utils from "./utils"
import * as Const from "./constants"


export function getOrCreateTransaction(id: string): Transaction {
    let transaction = Transaction.load(id)
    if (transaction == null) {
        transaction = new Transaction(id)
        transaction.id = id
        transaction.amount = constants.ZERO_BI
    }
    return transaction as Transaction
}

export function getOrCreateUser(id: Bytes): User {
    let user = User.load(id)
    if (!user) {
        user = new User(id)
        user.mintingDebt = constants.ZERO_BI
        user.tokenBalance = constants.ZERO_BI
        user.totalTokensHeld = constants.ZERO_BI
        user.tbtcToken = getOrCreateTbtcToken().id
        user.isRedeemerBanned = false
        user.deposits = []
        user.redemptions = []
    }
    return user
}

export function getOrCreateDeposit(id: Bytes): Deposit {
    let deposit = Deposit.load(id)
    if (!deposit) {
        deposit = new Deposit(id)
        deposit.status = "UNKNOWN"
        deposit.amount = constants.ZERO_BI
        deposit.transactions = []
        deposit.treasuryFee = constants.ZERO_BI
        deposit.actualAmountReceived = constants.ZERO_BI
        deposit.newDebt = constants.ZERO_BI
        deposit.depositTimestamp = constants.ZERO_BI
        deposit.sweptAt = constants.ZERO_BI
    }
    return deposit
}


export function getOrCreateRedemption(id: string): Redemption {
    let redemption = Redemption.load(id)
    if (!redemption) {
        redemption = new Redemption(id)
        redemption.status = "UNKNOWN"
        redemption.amount = constants.ZERO_BI
        redemption.transactions = []
        redemption.updateTimestamp = constants.ZERO_BI
    }
    return redemption
}


export function getOrCreateTbtcToken(): TBTCToken {
    let tBtcToken = TBTCToken.load("TBTCToken")

    if (!tBtcToken) {
        tBtcToken = new TBTCToken("TBTCToken")
        tBtcToken.decimals = 18
        tBtcToken.name = "tBTC v2"
        tBtcToken.symbol = "tBTC"
        tBtcToken.totalSupply = constants.ZERO_BI
        tBtcToken.totalMint = constants.ZERO_BI
        tBtcToken.totalBurn = constants.ZERO_BI
        tBtcToken.address = constants.ADDRESS_TBTC
        tBtcToken.currentTokenHolders = constants.ZERO_BI
    }

    return tBtcToken as TBTCToken
}

export function getOrCreateOperatorEvent(event: ethereum.Event, status: string): Event {
    let eventEntity = Event.load(Utils.getIDFromEvent(event))
    if (!eventEntity) {
        eventEntity = new Event(Utils.getIDFromEvent(event))
        eventEntity.from = event.transaction.from
        eventEntity.txHash = event.transaction.hash
        eventEntity.to = event.transaction.to
        eventEntity.contract = event.address
        eventEntity.timestamp = event.block.timestamp
        eventEntity.event = status
        eventEntity.amount = constants.ZERO_BI
        eventEntity.isRandomBeaconEvent = true
    }
    return eventEntity as Event
}

export function getStats(): StatsRecord {
    let stats = StatsRecord.load("current")
    if (stats == null) {
        stats = new StatsRecord("current")
        stats.numDeposits = 0
        stats.numRedemptions = 0
        stats.totalTBTCAuthorizationWeight = constants.ZERO_BI
        stats.totalRandomBeaconAuthorizationWeight = constants.ZERO_BI
        stats.mintingStatus = true
    }
    return stats as StatsRecord
}

export function getStatus(): StatusRecord {
    let status = StatusRecord.load("status")
    if (status == null) {
        status = new StatusRecord("status")
        status.groupState = "IDLE"
        status.ecdsaState = "IDLE"
        status.pendingRedemptions = []
        status.lastMintedInfo = []
        status.lastMintedHash = Bytes.empty()
    }
    return status as StatusRecord
}

export function getOrCreateOperator(address: Address): Operator {
    let operator = Operator.load(address.toHexString())
    if (!operator) {
        operator = new Operator(address.toHexString())
        operator.address = constants.ADDRESS_ZERO
        operator.randomBeaconAuthorized = false
        operator.tBTCAuthorized = false
        operator.tBTCAuthorizationWeight = constants.ZERO_BI
        operator.randomBeaconAuthorizationWeight = constants.ZERO_BI
        operator.availableReward = constants.ZERO_BI
        operator.rewardDispensed = constants.ZERO_BI
        operator.totalSlashedAmount = constants.ZERO_BI
        operator.misbehavedCount = 0
        operator.poolRewardBanDuration = constants.ZERO_BI
        operator.beaconGroupCount = 0
        operator.events = []
    }
    return operator as Operator
}

// Use the previously indexed value rather than event.fromAmount. An application
// migration can report an increase from zero while we still have its old value.
export function updateAuthorizationWeight(operator: Operator, weight: BigInt, isRandomBeacon: boolean): void {
    let stats = getStats()
    if (isRandomBeacon) {
        stats.totalRandomBeaconAuthorizationWeight = stats.totalRandomBeaconAuthorizationWeight
            .minus(operator.randomBeaconAuthorizationWeight).plus(weight)
        operator.randomBeaconAuthorizationWeight = weight
        operator.randomBeaconAuthorized = weight.gt(constants.ZERO_BI)
    } else {
        stats.totalTBTCAuthorizationWeight = stats.totalTBTCAuthorizationWeight
            .minus(operator.tBTCAuthorizationWeight).plus(weight)
        operator.tBTCAuthorizationWeight = weight
        operator.tBTCAuthorized = weight.gt(constants.ZERO_BI)
    }
    stats.save()
}

export function getOrCreateRandomBeaconGroup(id: string): RandomBeaconGroup {
    let group = RandomBeaconGroup.load(id)
    if (group == null) {
        group = new RandomBeaconGroup(id)
        group.createdAt = Const.ZERO_BI
        group.totalSlashedAmount = Const.ZERO_BI
        group.size = 0
        group.uniqueMemberCount = 0
        group.nonce = Const.ZERO_BI
        group.misbehavedCount = 0
        group.totalSlashedAmount = Const.ZERO_BI
        group.terminated = false
        group.isWalletRegistry = false
    }
    return group as RandomBeaconGroup
}
