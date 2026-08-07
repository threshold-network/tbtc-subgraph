import {
    Bridge,
    DepositParametersUpdated,
    DepositRevealed,
    DepositsSwept,
    EcdsaFraudRouterSet,
    FraudChallengeDefeated,
    FraudChallengeDefeatTimedOut,
    FraudChallengeSubmitted,
    FraudParametersUpdated,
    FrostWalletRegistrySet,
    GovernanceTransferred,
    Initialized,
    LegacyFraudChallengeMigrated,
    LifecycleRouterSet,
    MovedFundsSweepTimedOut,
    MovedFundsSwept,
    MovingFundsBelowDustReported,
    MovingFundsCommitmentSubmitted,
    MovingFundsCompleted,
    MovingFundsParametersUpdated,
    MovingFundsTimedOut,
    MovingFundsTimeoutReset,
    NewFrostWalletRegistered,
    NewWalletRegistered,
    NewWalletRegisteredV2,
    NewWalletRequested,
    NewWalletSchemeSet,
    P2TRFraudRouterSet,
    RedemptionParametersUpdated,
    RedemptionRequested,
    RedemptionsCompleted,
    RedemptionTimedOut,
    SpvMaintainerStatusUpdated,
    SubmitDepositSweepProofCall,
    SubmitRedemptionProofCall,
    TreasuryUpdated,
    VaultStatusUpdated,
    WalletClosed,
    WalletClosing,
    WalletMovingFunds,
    WalletParametersUpdated,
    WalletTerminated
} from "../generated/Bridge/Bridge"


import {BigInt, ByteArray, Bytes, crypto, ethereum, log} from '@graphprotocol/graph-ts'
import {BridgeState, Wallet, WalletSchemeChange} from "../generated/schema"
import {
    getOrCreateDeposit,
    getOrCreateRedemption,
    getOrCreateTbtcToken,
    getOrCreateTransaction,
    getOrCreateUser,
    getStats,
    getStatus
} from "./utils/helper"
import * as Utils from "./utils/utils"
import {getIDFromCall, getIDFromEvent} from "./utils/utils"
import * as Swept from "./swept"

import * as Const from "./utils/constants"
import * as BitcoinUtils from "./utils/bitcoin_utils";

function deriveLegacyWalletID(walletPubKeyHash: Bytes): Bytes {
    let walletPubKeyHashBytes = Utils.bytesToUint8Array(walletPubKeyHash)
    let walletIDBytes = new Uint8Array(32)
    let offset = 32 - walletPubKeyHashBytes.length

    for (let i = 0; i < walletPubKeyHashBytes.length; i++) {
        walletIDBytes[offset + i] = walletPubKeyHashBytes[i]
    }

    return Bytes.fromUint8Array(walletIDBytes)
}

// Schema enum values; mirror `WalletScheme` in schema.graphql.
const SCHEME_ECDSA = "ECDSA"
const SCHEME_FROST = "FROST"

// Singleton BridgeState id; the entity tracks the post-#431/#434/
// #435/#439 governance state that doesn't map cleanly to per-wallet
// records.
const BRIDGE_STATE_ID = "singleton"

function getOrCreateBridgeState(): BridgeState {
    let state = BridgeState.load(BRIDGE_STATE_ID)
    if (state == null) {
        state = new BridgeState(BRIDGE_STATE_ID)
        // C-2 default: scheme starts as ECDSA at C-2 activation; this
        // default value is correct for any pre-#439 historical record
        // since the only available scheme then was ECDSA.
        state.currentScheme = SCHEME_ECDSA
    }
    return state as BridgeState
}

function saveWalletRegistration(
    walletID: Bytes,
    ecdsaWalletID: Bytes,
    walletPubKeyHash: Bytes,
    scheme: string,
    event: ethereum.Event
): void {
    // FROST-only fields (xOnlyOutputKey) are populated by the
    // FROST handler after this helper returns, via a follow-up
    // load/save on the wallet entity. The earlier `Bytes | null`
    // parameter shape crashed AssemblyScript during `graph build`
    // (Codex P1 finding on the C-1.1a iteration); splitting the
    // FROST-specific field assignment out of this shared helper
    // keeps the helper signature monomorphic.
    let wallet = new Wallet(walletID)
    wallet.walletID = walletID
    wallet.ecdsaWalletID = ecdsaWalletID
    wallet.walletPubKeyHash = walletPubKeyHash
    wallet.registeredAt = event.block.timestamp
    wallet.registeredAtBlock = event.block.number
    wallet.transactionHash = event.transaction.hash
    wallet.scheme = scheme
    wallet.save()

    // The C-2 PR (#439) does NOT include the `ecdsaWalletCount`
    // on-chain counter or the `EcdsaWalletCountSeeded` event
    // originally specified in RFC v6 — they are deferred to a
    // focused C-2.1 follow-up (per the C-2 PR's bytecode-budget
    // rationale). C-1.1c will reintroduce the subgraph counter
    // bookkeeping using the on-chain `EcdsaWalletCountSeeded`
    // event's `totalAfterSeed` value as the idempotent absolute
    // counter source-of-truth (per Codex review feedback on the
    // earlier C-1.1a iteration that used `historicalCount += ` —
    // that double-counted under full reindex because the
    // historical events were already replayed).
}

export function handleDepositParametersUpdated(
    event: DepositParametersUpdated
): void {
}

export function handleDepositRevealed(event: DepositRevealed): void {
    let fundingTxHash = event.params.fundingTxHash
    let fundingOutputIndex = event.params.fundingOutputIndex
    // keccak256(fundingTxHash | fundingOutputIndex)
    let id = Utils.calculateDepositKey(Utils.bytesToUint8Array(fundingTxHash), fundingOutputIndex.toI32())

    let transaction = getOrCreateTransaction(getIDFromEvent(event))
    transaction.txHash = event.transaction.hash
    transaction.timestamp = event.block.timestamp
    transaction.from = event.transaction.from
    transaction.to = event.transaction.to
    transaction.amount = event.params.amount
    transaction.description = "Deposit Revealed"
    transaction.save()

    let bridgeContract = Bridge.bind(event.address)
    let depositsContract = bridgeContract.deposits(Utils.byteArrayToBigint(id))

    let deposit = getOrCreateDeposit(Bytes.fromByteArray(id))    
    deposit.status = "REVEALED"
    deposit.user = event.params.depositor
    deposit.amount = event.params.amount
    deposit.treasuryFee = depositsContract.treasuryFee
    deposit.walletPubKeyHash = event.params.walletPubKeyHash
    deposit.fundingTxHash = event.params.fundingTxHash
    deposit.fundingOutputIndex = event.params.fundingOutputIndex
    deposit.blindingFactor = event.params.blindingFactor
    deposit.refundPubKeyHash = event.params.refundPubKeyHash
    deposit.refundLocktime = event.params.refundLocktime
    deposit.vault = event.params.vault
    let transactions = deposit.transactions
    transactions.push(transaction.id)
    deposit.transactions = transactions
    deposit.depositTimestamp = event.block.timestamp
    deposit.updateTimestamp = event.block.timestamp
    deposit.save()

    let stats = getStats()
    stats.numDeposits += 1
    stats.save()

    let user = getOrCreateUser(event.params.depositor)
    let tBtcToken = getOrCreateTbtcToken()
    user.tbtcToken = tBtcToken.id
    let deposits = user.deposits
    deposits.push(deposit.id)
    user.deposits = deposits
    user.save()
}

export function callHandleSubmitDepositSweepProofCall(call: SubmitDepositSweepProofCall): void {
    Swept.processDepositSweepTxInputs(call);
}

export function handleDepositsSwept(event: DepositsSwept): void {

}

export function handleFraudChallengeDefeatTimedOut(
    event: FraudChallengeDefeatTimedOut
): void {
}

export function handleFraudChallengeDefeated(
    event: FraudChallengeDefeated
): void {
}

export function handleFraudChallengeSubmitted(
    event: FraudChallengeSubmitted
): void {
}

export function handleFraudParametersUpdated(
    event: FraudParametersUpdated
): void {
}

export function handleGovernanceTransferred(
    event: GovernanceTransferred
): void {
}

export function handleInitialized(event: Initialized): void {
}

export function handleMovedFundsSweepTimedOut(
    event: MovedFundsSweepTimedOut
): void {
}

export function handleMovedFundsSwept(event: MovedFundsSwept): void {
}

export function handleMovingFundsBelowDustReported(
    event: MovingFundsBelowDustReported
): void {
}

export function handleMovingFundsCommitmentSubmitted(
    event: MovingFundsCommitmentSubmitted
): void {
}

export function handleMovingFundsCompleted(event: MovingFundsCompleted): void {
}

export function handleMovingFundsParametersUpdated(
    event: MovingFundsParametersUpdated
): void {
}

export function handleMovingFundsTimedOut(event: MovingFundsTimedOut): void {
}

export function handleMovingFundsTimeoutReset(
    event: MovingFundsTimeoutReset
): void {
}

export function handleNewWalletRegistered(event: NewWalletRegistered): void {
    let walletID = deriveLegacyWalletID(event.params.walletPubKeyHash)
    saveWalletRegistration(
        walletID,
        event.params.ecdsaWalletID,
        event.params.walletPubKeyHash,
        SCHEME_ECDSA,
        event
    )

    log.info(
        "Bridge NewWalletRegistered walletID={} ecdsaWalletID={} walletPubKeyHash={}",
        [
            walletID.toHexString(),
            event.params.ecdsaWalletID.toHexString(),
            event.params.walletPubKeyHash.toHexString()
        ]
    )
}

export function handleNewWalletRegisteredV2(event: NewWalletRegisteredV2): void {
    // V2 fires for BOTH ECDSA wallets (alongside V1) and FROST
    // wallets (alongside NewFrostWalletRegistered, with
    // ecdsaWalletID = bytes32(0)). For ECDSA wallets the V1 handler
    // above already wrote the Wallet entity + counter; the V2 path
    // would double-count. Skip the V2 write for ECDSA wallets and
    // only act on V2 when the FROST handler hasn't run yet.
    //
    // For FROST wallets, `handleNewFrostWalletRegistered` writes
    // the Wallet entity first, so we also skip if a wallet entity
    // with this walletID already exists.
    let existing = Wallet.load(event.params.walletID)
    if (existing != null) {
        log.info(
            "Bridge NewWalletRegisteredV2 walletID={} already written by V1/FROST handler; skipping",
            [event.params.walletID.toHexString()]
        )
        return
    }
    // Unreachable in normal operation given how Wallets.sol emits
    // V1 + V2 paired for ECDSA and FROST + V2 paired for FROST, but
    // keep the fall-through for forward compatibility.
    // AssemblyScript Bytes does not implement `==`, so use
    // `.equals()` for the FROST-marker check.
    let zeroBytes32 = Bytes.fromHexString(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) as Bytes
    let scheme = event.params.ecdsaWalletID.equals(zeroBytes32)
        ? SCHEME_FROST
        : SCHEME_ECDSA
    saveWalletRegistration(
        event.params.walletID,
        event.params.ecdsaWalletID,
        event.params.walletPubKeyHash,
        scheme,
        event
    )
}

// C-1 prep: FROST wallet registration handler. Emits in parallel
// with NewWalletRegisteredV2 (with ecdsaWalletID = 0). The
// xOnlyOutputKey is the FROST-specific 32-byte canonical walletID.
// We populate it AFTER `saveWalletRegistration` returns (rather
// than via a nullable parameter on the shared helper) to keep the
// helper signature monomorphic and avoid the AssemblyScript
// compiler crash on `Bytes | null` parameter types.
export function handleNewFrostWalletRegistered(
    event: NewFrostWalletRegistered
): void {
    saveWalletRegistration(
        event.params.walletID,
        Bytes.fromHexString(
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) as Bytes,
        event.params.walletPubKeyHash,
        SCHEME_FROST,
        event
    )
    // FROST-specific field: load the just-written wallet and set
    // xOnlyOutputKey, then re-save. The entity is guaranteed to
    // exist because `saveWalletRegistration` just wrote it.
    let wallet = Wallet.load(event.params.walletID)
    if (wallet != null) {
        wallet.xOnlyOutputKey = event.params.xOnlyOutputKey
        wallet.save()
    }
    log.info(
        "Bridge NewFrostWalletRegistered walletID={} walletPubKeyHash={} xOnlyOutputKey={}",
        [
            event.params.walletID.toHexString(),
            event.params.walletPubKeyHash.toHexString(),
            event.params.xOnlyOutputKey.toHexString()
        ]
    )
}

// C-1 prep: one-time governance setter handlers. Each updates a
// field on the BridgeState singleton so consumers have a single
// place to look up post-upgrade configuration.

export function handleFrostWalletRegistrySet(
    event: FrostWalletRegistrySet
): void {
    let state = getOrCreateBridgeState()
    state.frostWalletRegistry = event.params.frostWalletRegistry
    state.save()
}

export function handleEcdsaFraudRouterSet(event: EcdsaFraudRouterSet): void {
    let state = getOrCreateBridgeState()
    state.ecdsaFraudRouter = event.params.ecdsaFraudRouter
    state.save()
}

export function handleP2TRFraudRouterSet(event: P2TRFraudRouterSet): void {
    let state = getOrCreateBridgeState()
    state.p2trFraudRouter = event.params.p2trFraudRouter
    state.save()
}

export function handleLifecycleRouterSet(event: LifecycleRouterSet): void {
    let state = getOrCreateBridgeState()
    state.lifecycleRouter = event.params.lifecycleRouter
    state.save()
}

// C-2 (#439): scheme flip event. Updates the BridgeState singleton
// and appends an audit-log entry. The enum is encoded as uint8 in
// the event payload (0 = ECDSA, 1 = FROST).
export function handleNewWalletSchemeSet(event: NewWalletSchemeSet): void {
    let scheme = event.params.scheme == 0 ? SCHEME_ECDSA : SCHEME_FROST

    let state = getOrCreateBridgeState()
    state.currentScheme = scheme
    state.save()

    let change = new WalletSchemeChange(getIDFromEvent(event))
    change.scheme = scheme
    change.changedAt = event.block.timestamp
    change.changedAtBlock = event.block.number
    change.transactionHash = event.transaction.hash
    change.save()

    log.info("Bridge NewWalletSchemeSet scheme={}", [scheme])
}

// C-2 (#439) ships only the scheme flip; the companion
// `EcdsaWalletCountSeeded` event + `ecdsaWalletCount` counter
// originally specified in RFC v6 are deferred to a focused C-2.1
// follow-up. C-1.1c will add the matching handler once C-2.1
// lands. Per the earlier C-1.1a review feedback (Codex P2), the
// handler MUST use `event.params.totalAfterSeed` to absolute-set
// the singleton — adding `historicalCount` would double-count
// because the historical `NewWalletRegistered` events have
// already been replayed by the time the seed event fires under
// the full-reindex deploy plan this PR documents.

// #435 one-time per-challenge legacy-fraud-challenge migration
// event. C-1 prep records the migration as a log line; the active
// challenge state lives on the router post-migration (handled by
// the matching router datasource added in C-1.1b).
export function handleLegacyFraudChallengeMigrated(
    event: LegacyFraudChallengeMigrated
): void {
    log.info(
        "Bridge LegacyFraudChallengeMigrated routerKind={} challengeKey={} challenger={} amount={}",
        [
            event.params.routerKind.toString(),
            event.params.challengeKey.toString(),
            event.params.challenger.toHexString(),
            event.params.depositAmount.toString()
        ]
    )
}

export function handleNewWalletRequested(event: NewWalletRequested): void {
}

export function handleRedemptionParametersUpdated(
    event: RedemptionParametersUpdated
): void {
}

function reformatRedemptionKeyIfExists(redeemerOutputScript: Bytes, walletPubKeyHash: Bytes): string {
    let loop = true
    let count = Const.ZERO_BI
    let id = ""
    while (loop) {
        id = Utils.calculateRedemptionKey(redeemerOutputScript, walletPubKeyHash, count)
        let redemption = getOrCreateRedemption(id)
        if (redemption.updateTimestamp.notEqual(Const.ZERO_BI)) {
            count = count.plus(Const.ONE_BI)
        } else {
            loop = false
        }
    }
    return id
}

function getLastRedemptionKey(
    redeemerOutputScript: Bytes, 
    walletPubKeyHash: Bytes, 
    calculateByScriptHash: boolean
): string {
    let loop = true
    let count = Const.ZERO_BI
    let id = ""
    let lastId = ""
    while (loop) {
        if (calculateByScriptHash) {
            id = Utils.calculateRedemptionKeyByScriptHash(redeemerOutputScript, walletPubKeyHash, count)  
        } else {
            id = Utils.calculateRedemptionKey(redeemerOutputScript, walletPubKeyHash, count)
        }
        let redemption = getOrCreateRedemption(id)
        if (redemption.updateTimestamp.notEqual(Const.ZERO_BI)) {
            count = count.plus(Const.ONE_BI)
            lastId = id
        } else {
            loop = false
        }
    }
    return lastId
}

export function handleRedemptionRequested(event: RedemptionRequested): void {
    let transaction = getOrCreateTransaction(getIDFromEvent(event))
    transaction.txHash = event.transaction.hash
    transaction.timestamp = event.block.timestamp
    transaction.from = event.transaction.from
    transaction.to = event.transaction.to
    transaction.amount = event.params.requestedAmount
    transaction.description = "Redemption Requested"
    transaction.save()

    let walletPubKeyHash = event.params.walletPubKeyHash
    let redeemerOutputScript = event.params.redeemerOutputScript

    // keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)
    let id = reformatRedemptionKeyIfExists(redeemerOutputScript, walletPubKeyHash)
    let redemption = getOrCreateRedemption(id)

    redemption.status = "REQUESTED"
    redemption.amount = event.params.requestedAmount
    redemption.user = event.params.redeemer
    redemption.treasuryFee = event.params.treasuryFee
    redemption.txMaxFee = event.params.txMaxFee
    redemption.redemptionTxHash = event.transaction.hash
    redemption.redemptionTimestamp = event.block.timestamp
    redemption.walletPubKeyHash = event.params.walletPubKeyHash
    redemption.redeemerOutputScript = event.params.redeemerOutputScript
    redemption.updateTimestamp = event.block.timestamp

    let user = getOrCreateUser(event.params.redeemer)
    let tBtcToken = getOrCreateTbtcToken()
    user.tbtcToken = tBtcToken.id
    let redemptions = user.redemptions
    redemptions.push(redemption.id)
    user.redemptions = redemptions
    user.save()

    let transactions = redemption.transactions
    transactions.push(transaction.id)
    redemption.transactions = transactions
    redemption.save()

    let stats = getStats()
    stats.numRedemptions += 1
    stats.save()
}

export function handleRedemptionTimedOut(event: RedemptionTimedOut): void {
    let walletPubKeyHash = event.params.walletPubKeyHash
    let redeemerOutputScript = event.params.redeemerOutputScript

    let transaction = getOrCreateTransaction(getIDFromEvent(event))
    transaction.txHash = event.transaction.hash
    transaction.timestamp = event.block.timestamp
    transaction.from = event.transaction.from
    transaction.to = event.transaction.to
    transaction.description = "Redemption TimedOut"
    transaction.save()

    let id = getLastRedemptionKey(redeemerOutputScript, walletPubKeyHash, false)
    let redemption = getOrCreateRedemption(id)
    redemption.status = "TIMEDOUT"
    redemption.updateTimestamp = event.block.timestamp
    let transactions = redemption.transactions
    transactions.push(transaction.id)
    redemption.transactions = transactions
    redemption.save()
}

function calculateOutputScriptHash(redemptionTxOutputVector: Uint8Array, outputScriptStart: i32, scriptLength: i32): ByteArray {
    const outputScriptData = redemptionTxOutputVector.subarray(outputScriptStart, outputScriptStart + scriptLength);
    let byteArray = new ByteArray(outputScriptData.length)
    for (let i = 0; i < outputScriptData.length; i++) {
        byteArray[i] = outputScriptData[i];
    }
    return crypto.keccak256(byteArray);
}

export function callHandlerSubmitRedemptionProof(call: SubmitRedemptionProofCall): void {
    const outputVector = call.inputs.redemptionTx.outputVector;
    const redemptionTxOutputVector = BitcoinUtils.parseVarInt(Utils.bytesToUint8Array(outputVector));
    const outputsCompactSizeUintLength = redemptionTxOutputVector.dataLength;
    const outputsCount = redemptionTxOutputVector.number.toI32();

    let outputStartingIndex = outputsCompactSizeUintLength.plus(BigInt.fromI32(1));
    for (let i: i32 = 0; i < outputsCount; i++) {
        let outputLength = BitcoinUtils.determineOutputLengthAt(outputVector, outputStartingIndex);

        let scriptLength = outputLength.minus(BigInt.fromI32(8));
        let outputScriptStart = outputStartingIndex.plus(BigInt.fromI32(8));
        let outputScript = calculateOutputScriptHash(Utils.bytesToUint8Array(outputVector), outputScriptStart.toI32(), scriptLength.toI32())

        let redemptionKey = getLastRedemptionKey(Bytes.fromByteArray(outputScript), call.inputs.walletPubKeyHash, true)

        let redemption = getOrCreateRedemption(redemptionKey);
        //Check if redemption exist
        if (redemption.status != "UNKNOWN" && redemption.updateTimestamp.notEqual(Const.ZERO_BI)) {

            let status = getStatus()
            //[1] : block hash , [0]: redemption hash
            let pendingRedemptions = status.pendingRedemptions
            if (status.pendingRedemptions[1] == call.block.hash) {
                let transaction = getOrCreateTransaction(getIDFromCall(call))
                transaction.txHash = call.transaction.hash
                transaction.timestamp = call.block.timestamp
                transaction.from = call.transaction.from
                transaction.to = call.transaction.to
                transaction.description = "Redemption success"
                transaction.save()

                redemption.status = "COMPLETED"
                redemption.completedTxHash = pendingRedemptions[0]
                redemption.updateTimestamp = call.block.timestamp
                let transactions = redemption.transactions
                transactions.push(transaction.id)
                redemption.transactions = transactions
                redemption.save()
            }
        }
        outputStartingIndex = outputStartingIndex.plus(outputLength)
    }
    //Reset pendingRedemptions list
    let status = getStatus()
    status.pendingRedemptions = []
    status.save()
}

export function handleRedemptionsCompleted(event: RedemptionsCompleted): void {
    let status = getStatus()
    let pendingRedemptions = status.pendingRedemptions
    pendingRedemptions.push(event.params.redemptionTxHash)
    pendingRedemptions.push(event.block.hash)
    status.pendingRedemptions = pendingRedemptions
    status.save()
}

export function handleSpvMaintainerStatusUpdated(
    event: SpvMaintainerStatusUpdated
): void {
}

export function handleTreasuryUpdated(event: TreasuryUpdated): void {
}

export function handleVaultStatusUpdated(event: VaultStatusUpdated): void {
}

export function handleWalletClosed(event: WalletClosed): void {
}

export function handleWalletClosing(event: WalletClosing): void {
}

export function handleWalletMovingFunds(event: WalletMovingFunds): void {
}

export function handleWalletParametersUpdated(
    event: WalletParametersUpdated
): void {
}

export function handleWalletTerminated(event: WalletTerminated): void {
}
