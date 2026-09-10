import {Address, BigInt, Bytes, ethereum, json} from "@graphprotocol/graph-ts"
import {assert, beforeEach, clearStore, createMockedFunction, newMockEvent, readFile, test} from "matchstick-as/assembly/index"
import {DepositInitialized, DepositFinalized, TokensTransferredWithPayload} from "../generated/BaseL1BitcoinDepositor/EvmWormholeL1BitcoinDepositor"
import {RedemptionRequested} from "../generated/L1BTCRedeemerWormhole/L1BTCRedeemerWormhole"
import {BridgeActivity, Redemption} from "../generated/schema"
import {handleBaseDepositInitialized, handleBaseDepositFinalized, handleBaseTokensTransferredWithPayload} from "../src/mappingBridgeActivity"
import {handleWormholeRedemptionRequested} from "../src/mappingL1BTCRedeemer"
import {RedemptionOrigin, eventTopic, originFromReceipt, wormholeChainName} from "../src/utils/bridge-origin"
import {calculateRedemptionKeyByBigInt, getIDFromEvent} from "../src/utils/utils"
import {getOrCreateRedemption} from "../src/utils/helper"

const TOKEN_BRIDGE = Address.fromString("0x3ee18b2214aff97000d974cf647e7c347e8fa585")
const EMITTER = Bytes.fromHexString("0x0000000000000000000000008d2de8d2f73f1f4cab472ac9a881c9b123c79627")
const SCRIPT_HASH = Bytes.fromHexString("0x" + "12".repeat(32))

function baseEvent(): ethereum.Event {
    let event = newMockEvent()
    event.logIndex = BigInt.fromI32(10)
    event.block.number = BigInt.fromI32(23000000)
    event.parameters = [
        new ethereum.EventParam("depositKey", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(123))),
        new ethereum.EventParam("destinationChainDepositOwner", ethereum.Value.fromFixedBytes(EMITTER)),
        new ethereum.EventParam("l1Sender", ethereum.Value.fromAddress(event.address))
    ]
    return event
}

function receiptLog(event: ethereum.Event, index: i32, address: Address, topics: Bytes[]): ethereum.Log {
    let entry = changetype<ethereum.TransactionReceipt>(newMockEvent().receipt).logs[0]
    entry.address = address
    entry.logIndex = BigInt.fromI32(index)
    entry.topics = topics
    entry.data = Bytes.fromHexString("0x")
    return entry
}

function transferLog(event: ethereum.Event, index: i32, chain: i32 = 30, address: Address = TOKEN_BRIDGE): ethereum.Log {
    return receiptLog(event, index, address, [
        Bytes.fromHexString(eventTopic("TransferRedeemed(uint16,bytes32,uint64)")),
        changetype<Bytes>(ethereum.encode(ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(chain)))),
        EMITTER,
        changetype<Bytes>(ethereum.encode(ethereum.Value.fromUnsignedBigInt(BigInt.fromString("18446744073709551615"))))
    ])
}

function redemptionEvent(): RedemptionRequested {
    let event = changetype<RedemptionRequested>(baseEvent())
    let utxo = new ethereum.Tuple()
    utxo.push(ethereum.Value.fromFixedBytes(SCRIPT_HASH))
    utxo.push(ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)))
    utxo.push(ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1000)))
    event.parameters = [
        new ethereum.EventParam("redemptionKey", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(123))),
        new ethereum.EventParam("walletPubKeyHash", ethereum.Value.fromFixedBytes(event.address)),
        new ethereum.EventParam("mainUtxo", ethereum.Value.fromTuple(utxo)),
        new ethereum.EventParam("redemptionOutputScript", ethereum.Value.fromFixedBytes(SCRIPT_HASH)),
        new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1234567890123456789")))
    ]
    changetype<ethereum.TransactionReceipt>(event.receipt).logs = [transferLog(event, 3)]
    createMockedFunction(event.address, "wormholeTokenBridge", "wormholeTokenBridge():(address)").returns([ethereum.Value.fromAddress(TOKEN_BRIDGE)])
    return event
}

beforeEach((): void => { clearStore() })

test("initialization has no invented amount and preserves bytes32 recipient", (): void => {
    let event = changetype<DepositInitialized>(baseEvent())
    handleBaseDepositInitialized(event)
    let id = getIDFromEvent(event)
    assert.fieldEquals("BridgeActivity", id, "sourceChain", "Bitcoin")
    assert.fieldEquals("BridgeActivity", id, "destinationChain", "Base")
    assert.fieldEquals("BridgeActivity", id, "recipientBytes32", EMITTER.toHexString())
    assert.assertTrue(changetype<BridgeActivity>(BridgeActivity.load(id)).amount === null)
    assert.fieldEquals("BridgeActivity", id, "sortKey", event.block.number.leftShift(32).plus(event.logIndex).toString())
})

test("finalization and transfer in one transaction remain distinct and use 18 decimal amounts", (): void => {
    let event = changetype<DepositFinalized>(baseEvent())
    event.parameters.push(new ethereum.EventParam("initialAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("2000000000000000000"))))
    event.parameters.push(new ethereum.EventParam("tbtcAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1990000000000000000"))))
    handleBaseDepositFinalized(event)
    let transfer = changetype<TokensTransferredWithPayload>(baseEvent())
    transfer.logIndex = BigInt.fromI32(11)
    transfer.parameters = [
        new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1990000000000000000"))),
        new ethereum.EventParam("l2Receiver", ethereum.Value.fromAddress(event.address)),
        new ethereum.EventParam("transferSequence", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(9)))
    ]
    handleBaseTokensTransferredWithPayload(transfer)
    assert.entityCount("BridgeActivity", 2)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "amount", "1990000000000000000")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(transfer), "sequence", "9")
})

test("inbound activity uses authenticated receipt metadata and updates the matching repeated redemption", (): void => {
    let event = redemptionEvent()
    let firstId = calculateRedemptionKeyByBigInt(event.params.redemptionKey, BigInt.zero())
    let first = getOrCreateRedemption(firstId)
    first.user = event.address
    first.redemptionTxHash = SCRIPT_HASH
    first.save()
    let secondId = calculateRedemptionKeyByBigInt(event.params.redemptionKey, BigInt.fromI32(1))
    let second = getOrCreateRedemption(secondId)
    second.user = event.address
    second.redemptionTxHash = event.transaction.hash
    second.save()
    handleWormholeRedemptionRequested(event)
    let id = getIDFromEvent(event)
    assert.fieldEquals("BridgeActivity", id, "sourceChain", "Base")
    assert.fieldEquals("BridgeActivity", id, "sourceChainId", "30")
    assert.fieldEquals("BridgeActivity", id, "sequence", "18446744073709551615")
    assert.fieldEquals("BridgeActivity", id, "redemptionOutputScriptHash", SCRIPT_HASH.toHexString())
    assert.fieldEquals("Redemption", secondId, "sourceChain", "BASE")
    assert.assertTrue(changetype<Redemption>(Redemption.load(firstId)).get("sourceChainId") === null)
})

test("source chain labels include mainnet and Sepolia spokes, not unlaunched chains", (): void => {
    assert.stringEquals(wormholeChainName(23), "Arbitrum")
    assert.stringEquals(wormholeChainName(10003), "Arbitrum")
    assert.stringEquals(wormholeChainName(10004), "Base")
    assert.stringEquals(wormholeChainName(1), "Solana")
    assert.stringEquals(wormholeChainName(21), "Sui")
    assert.stringEquals(wormholeChainName(10006), "Unknown")
})

test("missing receipts or reverted bridge reads retain an explicit unknown origin", (): void => {
    let event = redemptionEvent()
    event.receipt = null
    handleWormholeRedemptionRequested(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceChain", "Unknown")
    assert.entityCount("Redemption", 0)
    event = redemptionEvent()
    createMockedFunction(event.address, "wormholeTokenBridge", "wormholeTokenBridge():(address)").reverts()
    handleWormholeRedemptionRequested(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceChain", "Unknown")
})

test("spoofed, later, missing, malformed, and ambiguous transfer logs do not acquire an origin", (): void => {
    let event = redemptionEvent()
    let receipt = changetype<ethereum.TransactionReceipt>(event.receipt)
    receipt.logs = [transferLog(event, 3, 30, event.address)]
    assert.assertTrue(originFromReceipt(event, TOKEN_BRIDGE) === null)
    receipt.logs = [transferLog(event, 12)]
    assert.assertTrue(originFromReceipt(event, TOKEN_BRIDGE) === null)
    receipt.logs = []
    assert.assertTrue(originFromReceipt(event, TOKEN_BRIDGE) === null)
    receipt.logs = [transferLog(event, 3), transferLog(event, 4)]
    assert.assertTrue(originFromReceipt(event, TOKEN_BRIDGE) === null)
    let malformed = transferLog(event, 3)
    malformed.topics = [malformed.topics[0]]
    receipt.logs = [malformed]
    assert.assertTrue(originFromReceipt(event, TOKEN_BRIDGE) === null)
})

test("two redemptions in one receipt use separate log intervals even with unsorted input", (): void => {
    let event = redemptionEvent()
    let receipt = changetype<ethereum.TransactionReceipt>(event.receipt)
    receipt.logs = [
        transferLog(event, 7, 10003),
        receiptLog(event, 5, event.address, [Bytes.fromHexString(eventTopic("RedemptionRequested(uint256,bytes20,(bytes32,uint32,uint64),bytes,uint256)"))]),
        transferLog(event, 3, 30)
    ]
    let origin = originFromReceipt(event, TOKEN_BRIDGE)
    assert.assertTrue(origin !== null)
    assert.stringEquals(changetype<RedemptionOrigin>(origin).chain, "Arbitrum")
    event.logIndex = BigInt.fromI32(5)
    origin = originFromReceipt(event, TOKEN_BRIDGE)
    assert.stringEquals(changetype<RedemptionOrigin>(origin).chain, "Base")
})

// Real mainnet receipt, block 25906261, retrieved from public Ethereum RPC.
// Fixture values are independent of the encoder used by synthetic tests.
test("attributes a deployed Arbitrum redemption from its captured Ethereum receipt", (): void => {
    let fixture = json.fromBytes(readFile("tests/fixtures/arbitrum-redemption-receipt.json")).toObject()
    let event = redemptionEvent()
    let rawLogs = fixture.get("logs")!.toArray()
    let logs = new Array<ethereum.Log>()
    for (let i = 0; i < rawLogs.length; i++) {
        let raw = rawLogs[i].toObject()
        let topics = new Array<Bytes>()
        let rawTopics = raw.get("topics")!.toArray()
        for (let j = 0; j < rawTopics.length; j++) topics.push(Bytes.fromHexString(rawTopics[j].toString()))
        let entry = receiptLog(event, raw.get("logIndex")!.toI64() as i32, Address.fromString(raw.get("address")!.toString()), topics)
        entry.data = Bytes.fromHexString(raw.get("data")!.toString())
        logs.push(entry)
    }
    event.address = logs[1].address
    event.logIndex = logs[1].logIndex
    event.transaction.hash = Bytes.fromHexString(fixture.get("transactionHash")!.toString())
    changetype<ethereum.TransactionReceipt>(event.receipt).logs = logs
    let origin = originFromReceipt(event, TOKEN_BRIDGE)
    assert.assertTrue(origin !== null)
    assert.stringEquals(changetype<RedemptionOrigin>(origin).chain, "Arbitrum")
    assert.i32Equals(changetype<RedemptionOrigin>(origin).chainId, 23)
    assert.bigIntEquals(changetype<RedemptionOrigin>(origin).sequence, BigInt.fromI32(346693))
    assert.stringEquals(logs[1].topics[0].toHexString(), eventTopic("RedemptionRequested(uint256,bytes20,(bytes32,uint32,uint64),bytes,uint256)"))
})
