import {Address, BigInt, ByteArray, Bytes, crypto, ethereum} from "@graphprotocol/graph-ts"
import {L1BTCRedeemerWormhole} from "../../generated/L1BTCRedeemerWormhole/L1BTCRedeemerWormhole"

export class RedemptionOrigin {
    constructor(
        public chainId: i32,
        public chain: string,
        public emitterAddress: Bytes,
        public sequence: BigInt
    ) {}
}

// Wormhole IDs, not EVM chain IDs. Sepolia spokes use distinct Wormhole IDs.
// Unrecognized chains remain explicit instead of being guessed from the relayer.
export function wormholeChainName(chainId: i32): string {
    if (chainId == 1) return "Solana"
    if (chainId == 2 || chainId == 10002) return "Ethereum"
    if (chainId == 21) return "Sui"
    if (chainId == 23 || chainId == 10003) return "Arbitrum"
    if (chainId == 30 || chainId == 10004) return "Base"
    return "Unknown"
}

export function eventTopic(signature: string): string {
    return crypto.keccak256(ByteArray.fromUTF8(signature)).toHexString()
}

/**
 * The successful redeemer call consumes its VAA via completeTransferWithPayload
 * before emitting RedemptionRequested. Token Bridge authenticates the VAA and
 * emits TransferRedeemed with its emitter chain/address/sequence.
 *
 * Bound the search by the previous redemption from this contract so multiple
 * redemptions in one transaction cannot reuse each other's message. More than
 * one authentic transfer in that interval is ambiguous: keep Unknown. Never
 * attribute by tx.from, an arbitrary same-signature log, or tokenChain (which
 * describes the token's origin, not the sender's chain).
 */
export function originFromReceipt(event: ethereum.Event, tokenBridge: Address): RedemptionOrigin | null {
    let receipt = event.receipt
    if (receipt === null) return null
    let redemptionTopic = eventTopic("RedemptionRequested(uint256,bytes20,(bytes32,uint32,uint64),bytes,uint256)")
    let transferTopic = eventTopic("TransferRedeemed(uint16,bytes32,uint64)")
    let boundary = BigInt.fromI32(-1)
    let logs = receipt.logs
    for (let i = 0; i < logs.length; i++) {
        let entry = logs[i]
        if (entry.address.equals(event.address) && entry.topics.length > 0 &&
            entry.topics[0].toHexString() == redemptionTopic &&
            entry.logIndex.lt(event.logIndex) && entry.logIndex.gt(boundary)) {
            boundary = entry.logIndex
        }
    }
    let candidate: ethereum.Log | null = null
    for (let i = 0; i < logs.length; i++) {
        let entry = logs[i]
        if (!entry.address.equals(tokenBridge) || entry.topics.length == 0 ||
            entry.topics[0].toHexString() != transferTopic ||
            entry.logIndex.le(boundary) || entry.logIndex.ge(event.logIndex)) continue
        if (candidate !== null) return null
        candidate = entry
    }
    if (candidate === null || candidate.topics.length != 4 || candidate.data.length != 0) return null
    let chain = ethereum.decode("uint16", candidate.topics[1])
    let sequence = ethereum.decode("uint64", candidate.topics[3])
    if (chain === null || sequence === null || candidate.topics[2].length != 32) return null
    let chainId = chain.toI32()
    return new RedemptionOrigin(chainId, wormholeChainName(chainId), candidate.topics[2], sequence.toBigInt())
}

export function resolveRedemptionOrigin(event: ethereum.Event): RedemptionOrigin | null {
    if (event.receipt === null) return null
    // Read the configured contract at the event block. No hardcoded mainnet
    // address is applied to Sepolia, and a failed call never halts indexing.
    let tokenBridge = L1BTCRedeemerWormhole.bind(event.address).try_wormholeTokenBridge()
    if (tokenBridge.reverted) return null
    return originFromReceipt(event, tokenBridge.value)
}
