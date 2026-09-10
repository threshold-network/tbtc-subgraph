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
