import {Address, BigInt, Bytes, ethereum, json} from "@graphprotocol/graph-ts"
import {assert, beforeEach, clearStore, dataSourceMock, newMockEvent, readFile, test} from "matchstick-as/assembly/index"
import {TransferRedeemed} from "../generated/WormholeTokenBridge/WormholeTokenBridge"
import {Withdrawal} from "../generated/StarkGateBridge/StarkGateBridge"
import {BridgeActivity} from "../generated/schema"
import {handleStarkGateWithdrawal, handleWormholeTransferRedeemed} from "../src/mappingBridgeReturns"
import {eventTopic} from "../src/utils/bridge-origin"
import {ReturnContracts, returnContracts} from "../src/utils/bridge-return"
import {getIDFromEvent} from "../src/utils/utils"

const RECIPIENT = Address.fromString("0x1111111111111111111111111111111111111111")
const RELAYER = Address.fromString("0x2222222222222222222222222222222222222222")
const EMITTER = Bytes.fromHexString("0x0000000000000000000000000b2402144bb366a632d14b83f244d2e0e21bd39c")

function contracts(): ReturnContracts { return changetype<ReturnContracts>(returnContracts()) }
function encoded(value: ethereum.Value): Bytes { return changetype<Bytes>(ethereum.encode(value)) }
function uint(value: i32): ethereum.Value { return ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(value)) }

function logAt(address: Address, index: i32, topics: Bytes[], data: Bytes = Bytes.fromHexString("0x")): ethereum.Log {
    let entry = changetype<ethereum.TransactionReceipt>(newMockEvent().receipt).logs[0]
    entry.address = address
    entry.logIndex = BigInt.fromI32(index)
    entry.topics = topics
    entry.data = data
    return entry
}

function completionLog(index: i32, chain: i32 = 23, address: Address = contracts().wormhole): ethereum.Log {
    return logAt(address, index, [Bytes.fromHexString(eventTopic("TransferRedeemed(uint16,bytes32,uint64)")),
        encoded(uint(chain)), EMITTER, encoded(uint(index))])
}

function payoutLog(index: i32, recipient: Address = RECIPIENT, amount: i32 = 1000,
    token: Address = contracts().token, from: Address = contracts().wormhole): ethereum.Log {
    return logAt(token, index, [Bytes.fromHexString(eventTopic("Transfer(address,address,uint256)")),
        encoded(ethereum.Value.fromAddress(from)), encoded(ethereum.Value.fromAddress(recipient))], encoded(uint(amount)))
}

function setLogs(event: ethereum.Event, logs: ethereum.Log[]): void {
    changetype<ethereum.TransactionReceipt>(event.receipt).logs = logs
}

function completion(chain: i32 = 23, index: i32 = 10): TransferRedeemed {
    let event = changetype<TransferRedeemed>(newMockEvent())
    event.address = contracts().wormhole
    event.transaction.from = RELAYER
    event.block.number = BigInt.fromI32(25000000)
    event.logIndex = BigInt.fromI32(index)
    event.parameters = [new ethereum.EventParam("emitterChainId", uint(chain)),
        new ethereum.EventParam("emitterAddress", ethereum.Value.fromFixedBytes(EMITTER)),
        new ethereum.EventParam("sequence", uint(index))]
    setLogs(event, [completionLog(index, chain), payoutLog(index + 1)])
    return event
}

function withdrawal(): Withdrawal {
    let event = changetype<Withdrawal>(newMockEvent())
    event.address = contracts().starkGate
    event.transaction.from = RELAYER
    event.logIndex = BigInt.fromI32(20)
    event.parameters = [new ethereum.EventParam("recipient", ethereum.Value.fromAddress(RECIPIENT)),
        new ethereum.EventParam("token", ethereum.Value.fromAddress(contracts().token)),
        new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1234567890123456789")))]
    return event
}

beforeEach((): void => {
    clearStore()
    dataSourceMock.setNetwork("mainnet")
})

test("captured Arbitrum return identifies the authenticated source and native tBTC recipient", (): void => {
    let fixture = json.fromBytes(readFile("tests/fixtures/arbitrum-return-receipt.json")).toObject()
    let rawLogs = fixture.get("logs")!.toArray()
    let logs = new Array<ethereum.Log>()
    for (let i = 0; i < rawLogs.length; i++) {
        let raw = rawLogs[i].toObject()
        let topics = new Array<Bytes>()
        let rawTopics = raw.get("topics")!.toArray()
        for (let j = 0; j < rawTopics.length; j++) topics.push(Bytes.fromHexString(rawTopics[j].toString()))
        logs.push(logAt(Address.fromString(raw.get("address")!.toString()), raw.get("logIndex")!.toI64() as i32,
            topics, Bytes.fromHexString(raw.get("data")!.toString())))
    }
    let event = completion()
    event.logIndex = logs[0].logIndex
    event.block.number = BigInt.fromI64(fixture.get("blockNumber")!.toI64())
    event.transaction.hash = Bytes.fromHexString(fixture.get("transactionHash")!.toString())
    event.parameters = [new ethereum.EventParam("emitterChainId", ethereum.decode("uint16", logs[0].topics[1])!),
        new ethereum.EventParam("emitterAddress", ethereum.Value.fromFixedBytes(logs[0].topics[2])),
        new ethereum.EventParam("sequence", ethereum.decode("uint64", logs[0].topics[3])!)]
    setLogs(event, logs)
    handleWormholeTransferRedeemed(event)
    let id = getIDFromEvent(event)
    assert.fieldEquals("BridgeActivity", id, "type", "TRANSFER_RECEIVED")
    assert.fieldEquals("BridgeActivity", id, "sourceChain", "Arbitrum")
    assert.fieldEquals("BridgeActivity", id, "sourceChainId", "23")
    assert.fieldEquals("BridgeActivity", id, "destinationChain", "Ethereum")
    assert.fieldEquals("BridgeActivity", id, "recipient", "0x8f162693231093d9ce8b794e179b1b00c72cff9e")
    assert.fieldEquals("BridgeActivity", id, "amount", "37127440000000000")
    assert.fieldEquals("BridgeActivity", id, "sequence", "346835")
    assert.assertTrue(changetype<BridgeActivity>(BridgeActivity.load(id)).sender === null)
})

test("a relayer fee is not counted as another arrival or included in the net received amount", (): void => {
    let event = completion(30)
    setLogs(event, [completionLog(10, 30), payoutLog(11, RELAYER, 100), payoutLog(12, RECIPIENT, 900)])
    handleWormholeTransferRedeemed(event)
    assert.entityCount("BridgeActivity", 1)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "amount", "900")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "recipient", RECIPIENT.toHexString())
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceChain", "Base")
})

test("a recipient claiming their own message receives the full single payout", (): void => {
    let event = completion()
    event.transaction.from = RECIPIENT
    handleWormholeTransferRedeemed(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "amount", "1000")
    assert.assertTrue(changetype<BridgeActivity>(BridgeActivity.load(getIDFromEvent(event))).sender === null)
})

test("a zero net payout never turns the arbiter payment into the recipient payment", (): void => {
    let event = completion()
    setLogs(event, [completionLog(10), payoutLog(11, RELAYER, 1000), payoutLog(12, RECIPIENT, 0)])
    handleWormholeTransferRedeemed(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "amount", "0")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "recipient", RECIPIENT.toHexString())
})

test("batched returns have distinct IDs, source chains, recipients and amounts", (): void => {
    let first = completion()
    let second = completion(30, 20)
    let logs = [completionLog(10), payoutLog(11), completionLog(20, 30), payoutLog(21, RELAYER, 2000)]
    setLogs(first, logs)
    setLogs(second, logs)
    handleWormholeTransferRedeemed(first)
    handleWormholeTransferRedeemed(second)
    assert.entityCount("BridgeActivity", 2)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(first), "amount", "1000")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(first), "sourceChain", "Arbitrum")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(second), "amount", "2000")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(second), "sourceChain", "Base")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(second), "recipient", RELAYER.toHexString())
})

test("a non-tBTC completion cannot borrow the next completion's tBTC payout", (): void => {
    let first = completion()
    let second = completion(30, 20)
    let logs = [completionLog(10), payoutLog(11, RECIPIENT, 1000, RELAYER), completionLog(20, 30), payoutLog(21)]
    setLogs(first, logs)
    setLogs(second, logs)
    handleWormholeTransferRedeemed(first)
    handleWormholeTransferRedeemed(second)
    assert.entityCount("BridgeActivity", 1)
    assert.notInStore("BridgeActivity", getIDFromEvent(first))
    assert.fieldEquals("BridgeActivity", getIDFromEvent(second), "sourceChain", "Base")
})

test("Bitcoin redemption legs are excluded without hiding another return in the same batch", (): void => {
    let first = completion()
    let second = completion(30, 20)
    let logs = [completionLog(10), payoutLog(11, contracts().bitcoinRedeemer), completionLog(20, 30), payoutLog(21)]
    setLogs(first, logs)
    setLogs(second, logs)
    handleWormholeTransferRedeemed(first)
    handleWormholeTransferRedeemed(second)
    assert.entityCount("BridgeActivity", 1)
    assert.notInStore("BridgeActivity", getIDFromEvent(first))
    assert.fieldEquals("BridgeActivity", getIDFromEvent(second), "type", "TRANSFER_RECEIVED")
})

test("spoofed completion and transfer logs do not change the authenticated payout", (): void => {
    let event = completion()
    setLogs(event, [payoutLog(9), completionLog(10), completionLog(11, 30, RELAYER),
        payoutLog(12, RELAYER, 2000, RELAYER), payoutLog(13, RELAYER, 2000, contracts().token, RELAYER), payoutLog(14)])
    handleWormholeTransferRedeemed(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceChain", "Arbitrum")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "recipient", RECIPIENT.toHexString())
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "amount", "1000")
})

test("missing receipts and missing native-token payouts do not create arrivals", (): void => {
    let event = completion()
    setLogs(event, [completionLog(10)])
    handleWormholeTransferRedeemed(event)
    event.receipt = null
    handleWormholeTransferRedeemed(event)
    assert.entityCount("BridgeActivity", 0)
})

test("malformed or ambiguous tBTC payout evidence does not create an arrival", (): void => {
    let event = completion()
    let malformed = payoutLog(11)
    malformed.data = Bytes.fromHexString("0x1234")
    setLogs(event, [completionLog(10), malformed])
    handleWormholeTransferRedeemed(event)
    setLogs(event, [completionLog(10), payoutLog(11), payoutLog(12), payoutLog(13)])
    handleWormholeTransferRedeemed(event)
    assert.entityCount("BridgeActivity", 0)
})

test("unrecognized source IDs remain explicit and Sei remains excluded", (): void => {
    let unknown = completion(65000)
    handleWormholeTransferRedeemed(unknown)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(unknown), "sourceChain", "Unknown")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(unknown), "sourceChainId", "65000")
    let sei = completion(32, 20)
    handleWormholeTransferRedeemed(sei)
    assert.notInStore("BridgeActivity", getIDFromEvent(sei))
})

test("StarkGate indexes the completed tBTC withdrawal with its Ethereum recipient", (): void => {
    let event = withdrawal()
    event.receipt = null // The trusted Withdrawal event itself proves settlement.
    handleStarkGateWithdrawal(event)
    let id = getIDFromEvent(event)
    assert.fieldEquals("BridgeActivity", id, "type", "TRANSFER_RECEIVED")
    assert.fieldEquals("BridgeActivity", id, "protocol", "StarkGate")
    assert.fieldEquals("BridgeActivity", id, "sourceChain", "StarkNet")
    assert.fieldEquals("BridgeActivity", id, "destinationChain", "Ethereum")
    assert.fieldEquals("BridgeActivity", id, "amount", "1234567890123456789")
    assert.fieldEquals("BridgeActivity", id, "recipient", RECIPIENT.toHexString())
    assert.assertTrue(changetype<BridgeActivity>(BridgeActivity.load(id)).sender === null)
    assert.assertTrue(changetype<BridgeActivity>(BridgeActivity.load(id)).sequence === null)
})

test("other tokens and unconfigured bridges are excluded", (): void => {
    let otherToken = withdrawal()
    otherToken.parameters[1] = new ethereum.EventParam("token", ethereum.Value.fromAddress(RELAYER))
    handleStarkGateWithdrawal(otherToken)
    let otherBridge = withdrawal()
    otherBridge.address = RELAYER
    handleStarkGateWithdrawal(otherBridge)
    let wormhole = completion()
    wormhole.address = RELAYER
    handleWormholeTransferRedeemed(wormhole)
    assert.entityCount("BridgeActivity", 0)
})

test("Sepolia uses its own bridge/token deployments and source-chain IDs", (): void => {
    let mainnetReturn = completion()
    let mainnetWithdrawal = withdrawal()
    dataSourceMock.setNetwork("sepolia")
    handleWormholeTransferRedeemed(mainnetReturn)
    handleStarkGateWithdrawal(mainnetWithdrawal)
    assert.entityCount("BridgeActivity", 0)
    let event = completion(10003)
    handleWormholeTransferRedeemed(event)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceChain", "Arbitrum")
    assert.fieldEquals("BridgeActivity", getIDFromEvent(event), "sourceContract", "0xdb5492265f6038831e89f495670ff909ade94bd9")
    let starkGate = withdrawal()
    handleStarkGateWithdrawal(starkGate)
    assert.fieldEquals("BridgeActivity", getIDFromEvent(starkGate), "sourceContract", "0xf6217de888fd6e6b2cbfbb2370973be4c36a152d")
    assert.entityCount("BridgeActivity", 2)
})

test("unsupported networks do not fall back to mainnet deployments", (): void => {
    let wormhole = completion()
    let starkGate = withdrawal()
    dataSourceMock.setNetwork("unknown")
    handleWormholeTransferRedeemed(wormhole)
    handleStarkGateWithdrawal(starkGate)
    assert.entityCount("BridgeActivity", 0)
})
