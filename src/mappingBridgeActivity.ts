import {BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts"

import {
    DepositFinalized as ArbitrumDepositFinalized,
    DepositInitialized as ArbitrumDepositInitialized,
    DepositFinalized1 as LegacyArbitrumDepositFinalized,
    DepositInitialized1 as LegacyArbitrumDepositInitialized,
    TokensTransferredWithPayload as ArbitrumTokensTransferredWithPayload
} from "../generated/ArbitrumL1BitcoinDepositor/EvmWormholeL1BitcoinDepositor"
import {
    DepositFinalized as BaseDepositFinalized,
    DepositInitialized as BaseDepositInitialized,
    DepositFinalized1 as LegacyBaseDepositFinalized,
    DepositInitialized1 as LegacyBaseDepositInitialized,
    TokensTransferredWithPayload as BaseTokensTransferredWithPayload
} from "../generated/BaseL1BitcoinDepositor/EvmWormholeL1BitcoinDepositor"
import {
    DepositFinalized as SolanaDepositFinalized,
    DepositInitialized as SolanaDepositInitialized,
    TokensTransferredWithPayload as SolanaTokensTransferredWithPayload
} from "../generated/SolanaL1BitcoinDepositor/NonEvmWormholeL1BitcoinDepositor"
import {
    DepositFinalized as SuiDepositFinalized,
    DepositInitialized as SuiDepositInitialized,
    TokensTransferredWithPayload as SuiTokensTransferredWithPayload
} from "../generated/SuiBTCDepositorWormhole/NonEvmWormholeL1BitcoinDepositor"
import {
    DepositFinalized as StarkNetDepositFinalized,
    DepositInitialized as StarkNetDepositInitialized,
    TBTCBridgedToStarkNet
} from "../generated/StarkNetBitcoinDepositor/StarkNetBitcoinDepositor"
import {RedemptionRequested} from "../generated/L1BTCRedeemerWormhole/L1BTCRedeemerWormhole"
import {BridgeActivity} from "../generated/schema"
import {resolveRedemptionOrigin} from "./utils/bridge-origin"
import {getIDFromEvent} from "./utils/utils"

// Match routed-deposit normalization: legacy EVM owners occupy the final
// 20 bytes of the 32-byte destination field used by current lifecycle events.
function leftPadAddressTo32Bytes(address: Bytes): Bytes {
    return new Bytes(12).concat(address)
}

export function createBridgeActivity(
    event: ethereum.Event,
    activityType: string,
    direction: string,
    protocol: string,
    sourceChain: string,
    destinationChain: string
): BridgeActivity {
    let activity = new BridgeActivity(getIDFromEvent(event))
    activity.sortKey = event.block.number.leftShift(32).plus(event.logIndex)
    activity.type = activityType
    activity.direction = direction
    activity.protocol = protocol
    activity.sourceChain = sourceChain
    activity.destinationChain = destinationChain
    activity.sourceContract = event.address
    activity.txHash = event.transaction.hash
    activity.logIndex = event.logIndex
    activity.blockNumber = event.block.number
    activity.timestamp = event.block.timestamp

    return activity
}

function saveDepositInitialized(
    event: ethereum.Event,
    protocol: string,
    destinationChain: string,
    depositKey: BigInt,
    destinationChainDepositOwner: Bytes,
    l1Sender: Bytes
): void {
    let activity = createBridgeActivity(
        event,
        "DEPOSIT_INITIALIZED",
        "IN",
        protocol,
        "Bitcoin",
        destinationChain
    )
    activity.depositKey = depositKey
    activity.recipientBytes32 = destinationChainDepositOwner
    activity.sender = l1Sender
    activity.save()
}

function saveDepositFinalized(
    event: ethereum.Event,
    protocol: string,
    destinationChain: string,
    depositKey: BigInt,
    destinationChainDepositOwner: Bytes,
    l1Sender: Bytes,
    initialAmount: BigInt,
    tbtcAmount: BigInt
): void {
    let activity = createBridgeActivity(
        event,
        "DEPOSIT_FINALIZED",
        "OUT",
        protocol,
        "Ethereum",
        destinationChain
    )
    activity.depositKey = depositKey
    activity.recipientBytes32 = destinationChainDepositOwner
    activity.sender = l1Sender
    activity.initialAmount = initialAmount
    activity.tbtcAmount = tbtcAmount
    activity.amount = tbtcAmount
    activity.save()
}

function saveEvmWormholeTransfer(
    event: ethereum.Event,
    destinationChain: string,
    amount: BigInt,
    receiver: Bytes,
    sequence: BigInt
): void {
    let activity = createBridgeActivity(
        event,
        "TOKENS_TRANSFERRED_WITH_PAYLOAD",
        "OUT",
        "Wormhole",
        "Ethereum",
        destinationChain
    )
    activity.amount = amount
    activity.recipient = receiver
    activity.sequence = sequence
    activity.save()
}

function saveNonEvmWormholeTransfer(
    event: ethereum.Event,
    destinationChain: string,
    amount: BigInt,
    receiver: Bytes,
    sequence: BigInt
): void {
    let activity = createBridgeActivity(
        event,
        "TOKENS_TRANSFERRED_WITH_PAYLOAD",
        "OUT",
        "Wormhole",
        "Ethereum",
        destinationChain
    )
    activity.amount = amount
    activity.recipientBytes32 = receiver
    activity.sequence = sequence
    activity.save()
}

export function handleArbitrumDepositInitialized(event: ArbitrumDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Arbitrum",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender
    )
}

export function handleArbitrumDepositFinalized(event: ArbitrumDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Arbitrum",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleLegacyArbitrumDepositInitialized(event: LegacyArbitrumDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Arbitrum",
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender
    )
}

export function handleLegacyArbitrumDepositFinalized(event: LegacyArbitrumDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Arbitrum",
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleArbitrumTokensTransferredWithPayload(
    event: ArbitrumTokensTransferredWithPayload
): void {
    saveEvmWormholeTransfer(
        event,
        "Arbitrum",
        event.params.amount,
        event.params.l2Receiver,
        event.params.transferSequence
    )
}

export function handleBaseDepositInitialized(event: BaseDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Base",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender
    )
}

export function handleBaseDepositFinalized(event: BaseDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Base",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleLegacyBaseDepositInitialized(event: LegacyBaseDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Base",
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender
    )
}

export function handleLegacyBaseDepositFinalized(event: LegacyBaseDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Base",
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleBaseTokensTransferredWithPayload(
    event: BaseTokensTransferredWithPayload
): void {
    saveEvmWormholeTransfer(
        event,
        "Base",
        event.params.amount,
        event.params.l2Receiver,
        event.params.transferSequence
    )
}

export function handleSolanaDepositInitialized(event: SolanaDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Solana",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender
    )
}

export function handleSolanaDepositFinalized(event: SolanaDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Solana",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleSolanaTokensTransferredWithPayload(
    event: SolanaTokensTransferredWithPayload
): void {
    saveNonEvmWormholeTransfer(
        event,
        "Solana",
        event.params.amount,
        event.params.destinationChainReceiver,
        event.params.transferSequence
    )
}

export function handleSuiDepositInitialized(event: SuiDepositInitialized): void {
    saveDepositInitialized(
        event,
        "Wormhole",
        "Sui",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender
    )
}

export function handleSuiDepositFinalized(event: SuiDepositFinalized): void {
    saveDepositFinalized(
        event,
        "Wormhole",
        "Sui",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleSuiTokensTransferredWithPayload(
    event: SuiTokensTransferredWithPayload
): void {
    saveNonEvmWormholeTransfer(
        event,
        "Sui",
        event.params.amount,
        event.params.destinationChainReceiver,
        event.params.transferSequence
    )
}

export function handleStarkNetDepositInitialized(event: StarkNetDepositInitialized): void {
    saveDepositInitialized(
        event,
        "StarkGate",
        "StarkNet",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender
    )
}

export function handleStarkNetDepositFinalized(event: StarkNetDepositFinalized): void {
    saveDepositFinalized(
        event,
        "StarkGate",
        "StarkNet",
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.params.initialAmount,
        event.params.tbtcAmount
    )
}

export function handleTBTCBridgedToStarkNet(event: TBTCBridgedToStarkNet): void {
    let activity = createBridgeActivity(
        event,
        "TBTC_BRIDGED_TO_STARKNET",
        "OUT",
        "StarkGate",
        "Ethereum",
        "StarkNet"
    )
    activity.sender = event.params.sender
    activity.amount = event.params.amount
    activity.starkNetRecipient = event.params.starkNetRecipient
    activity.fee = event.params.fee
    activity.save()
}

export function createRedemptionActivity(event: RedemptionRequested): BridgeActivity {
    let activity = createBridgeActivity(
        event,
        "REDEMPTION_REQUESTED",
        "IN",
        "Wormhole",
        "Unknown",
        "Bitcoin"
    )
    let origin = resolveRedemptionOrigin(event)
    if (origin !== null) {
        activity.sourceChain = origin.chain
        activity.sourceChainId = origin.chainId
        activity.emitterAddress = origin.emitterAddress
        activity.sequence = origin.sequence
    }
    activity.redemptionKey = event.params.redemptionKey
    activity.walletPubKeyHash = event.params.walletPubKeyHash
    activity.redemptionOutputScriptHash = event.params.redemptionOutputScript
    activity.amount = event.params.amount
    activity.mainUtxoTxHash = event.params.mainUtxo.txHash
    activity.mainUtxoOutputIndex = event.params.mainUtxo.txOutputIndex
    activity.mainUtxoOutputValue = event.params.mainUtxo.txOutputValue
    activity.save()
    return activity
}
