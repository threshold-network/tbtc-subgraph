import {Address, BigInt, dataSource, ethereum} from "@graphprotocol/graph-ts"
import {eventTopic} from "./bridge-origin"

export class ReturnContracts {
    constructor(
        public token: Address,
        public wormhole: Address,
        public starkGate: Address,
        public bitcoinRedeemer: Address
    ) {}
}

// Network-specific deployment addresses. Unknown networks must not use mainnet.
export function returnContracts(): ReturnContracts | null {
    let network = dataSource.network()
    if (network == "mainnet") return new ReturnContracts(
        Address.fromString("0x18084fbA666a33d37592fA2633fD49a74DD93a88"),
        Address.fromString("0x3ee18B2214AFF97000D974cf647E7C347E8fa585"),
        Address.fromString("0x2111A49ebb717959059693a3698872a0aE9866b9"),
        Address.fromString("0x5D4d83aaB53B7E7cA915AEB2d4d3f4e03823DbDe")
    )
    if (network == "sepolia") return new ReturnContracts(
        Address.fromString("0x517f2982701695D4E52f1ECFBEf3ba31Df470161"),
        Address.fromString("0xDB5492265f6038831E89f495670FF909aDe94bd9"),
        Address.fromString("0xF6217de888fD6E6b2CbFBB2370973BE4c36a152D"),
        Address.fromString("0xe8312BD306512c5CAD4D650df373D5597B1C697A")
    )
    return null
}

export class TokenPayout {
    constructor(public recipient: Address, public amount: BigInt) {}
}

/**
 * Token Bridge emits TransferRedeemed after authenticating the VAA, then pays
 * the optional arbiter fee, then the recipient. Native tBTC's Transfer logs
 * identify the token and actual received amount (already in 18-decimal units).
 * Bound each completion by the next authentic completion, including non-tBTC
 * messages, so batches cannot borrow a later message's amount or recipient.
 */
export function wormholePayout(event: ethereum.Event, token: Address): TokenPayout | null {
    let receipt = event.receipt
    if (receipt === null) return null
    let completionTopic = eventTopic("TransferRedeemed(uint16,bytes32,uint64)")
    let transferTopic = eventTopic("Transfer(address,address,uint256)")
    let boundary: BigInt | null = null
    let logs = receipt.logs
    for (let i = 0; i < logs.length; i++) {
        let entry = logs[i]
        if (entry.address.equals(event.address) && entry.topics.length > 0 &&
            entry.topics[0].toHexString() == completionTopic && entry.logIndex.gt(event.logIndex) &&
            (boundary === null || entry.logIndex.lt(boundary))) boundary = entry.logIndex
    }
    let payout: TokenPayout | null = null
    let lastIndex = event.logIndex
    let count = 0
    for (let i = 0; i < logs.length; i++) {
        let entry = logs[i]
        if (!entry.address.equals(token) || entry.topics.length == 0 ||
            entry.topics[0].toHexString() != transferTopic || entry.logIndex.le(event.logIndex) ||
            (boundary !== null && entry.logIndex.ge(boundary))) continue
        if (entry.topics.length != 3 || entry.data.length != 32) return null
        let from = ethereum.decode("address", entry.topics[1])
        let to = ethereum.decode("address", entry.topics[2])
        let amount = ethereum.decode("uint256", entry.data)
        if (from === null || to === null || amount === null) return null
        if (!from.toAddress().equals(event.address)) continue
        count++
        // One recipient payment and at most one arbiter payment are expected.
        if (count > 2) return null
        if (entry.logIndex.gt(lastIndex)) {
            lastIndex = entry.logIndex
            payout = new TokenPayout(to.toAddress(), amount.toBigInt())
        }
    }
    return payout
}
