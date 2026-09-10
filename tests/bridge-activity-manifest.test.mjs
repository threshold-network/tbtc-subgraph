import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {test} from "node:test"
import YAML from "yaml"

const root = new URL("../", import.meta.url)
const manifest = YAML.parse(readFileSync(new URL("subgraph.yaml", root), "utf8"))
const normalize = (signature) => signature.replace(/\s+/g, "")

for (const chain of ["Arbitrum", "Base"]) {
    test(`${chain} activity subscribes to both lifecycle event eras`, () => {
        const source = manifest.dataSources.find(({name}) => name === `${chain}L1BitcoinDepositor`)
        assert.ok(source, `missing ${chain} activity source`)
        const abiFile = source.mapping.abis.find(({name}) => name === source.source.abi).file
        const abi = JSON.parse(readFileSync(new URL(abiFile, root), "utf8"))
        const abiSignatures = abi.filter(({type}) => type === "event").map(({name, inputs}) =>
            normalize(`${name}(${inputs.map(({indexed, type}) => `${indexed ? "indexed " : ""}${type}`).join(",")})`)
        )

        for (const owner of ["bytes32", "address"]) {
            for (const lifecycle of ["Initialized", "Finalized"]) {
                const amounts = lifecycle === "Finalized" ? ",uint256,uint256" : ""
                const signature = `Deposit${lifecycle}(indexed uint256,indexed ${owner},indexed address${amounts})`
                const registration = source.mapping.eventHandlers.find(({event}) => normalize(event) === normalize(signature))
                assert.ok(registration, `missing ${signature} subscription`)
                assert.equal(registration.handler, `handle${owner === "address" ? "Legacy" : ""}${chain}Deposit${lifecycle}`)
                assert.ok(abiSignatures.includes(normalize(signature)), `missing ${signature} ABI entry`)
            }
        }
    })
}

for (const [name, signature, handler, needsReceipt] of [
    ["WormholeTokenBridge", "TransferRedeemed(indexed uint16,indexed bytes32,indexed uint64)", "handleWormholeTransferRedeemed", true],
    ["StarkGateBridge", "Withdrawal(indexed address,indexed address,uint256)", "handleStarkGateWithdrawal", false],
]) {
    test(`${name} subscribes to the completion event with the correct ABI`, () => {
        const source = manifest.dataSources.find((source) => source.name === name)
        assert.ok(source, `missing ${name} data source`)
        assert.equal(source.mapping.file, "./src/mappingBridgeReturns.ts")
        assert.equal(source.mapping.eventHandlers.length, 1)
        const registration = source.mapping.eventHandlers[0]
        assert.equal(normalize(registration.event), normalize(signature))
        assert.equal(registration.handler, handler)
        assert.equal(!!registration.receipt, needsReceipt)
        const abiFile = source.mapping.abis.find(({name}) => name === source.source.abi).file
        const abi = JSON.parse(readFileSync(new URL(abiFile, root), "utf8"))
        const event = abi.find(({type}) => type === "event")
        assert.equal(normalize(`${event.name}(${event.inputs.map(({indexed, type}) => `${indexed ? "indexed " : ""}${type}`).join(",")})`), normalize(signature))
    })
}

test("return subscriptions preserve both networks and do not omit early tBTC history", () => {
    const networks = JSON.parse(readFileSync(new URL("networks.json", root), "utf8"))
    const expected = {
        mainnet: ["0x3ee18b2214aff97000d974cf647e7c347e8fa585", "0x2111a49ebb717959059693a3698872a0ae9866b9"],
        sepolia: ["0xdb5492265f6038831e89f495670ff909ade94bd9", "0xf6217de888fd6e6b2cbfbb2370973be4c36a152d"],
    }
    for (const [network, addresses] of Object.entries(expected)) {
        for (const [index, name] of ["WormholeTokenBridge", "StarkGateBridge"].entries()) {
            assert.equal(networks[network][name].address.toLowerCase(), addresses[index])
            assert.ok(networks[network][name].startBlock <= networks[network].TBTC.startBlock)
        }
    }
})
