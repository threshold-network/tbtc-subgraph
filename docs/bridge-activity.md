# Bridge activity

`BridgeActivity` records Ethereum hub events, one row per transaction hash and
log index. It covers Arbitrum, Base, Solana, Sui, and Starknet direct mint
lifecycle events, the depositor transfer events, and inbound Bitcoin redemptions
through `L1BTCRedeemerWormhole`. It also records completed standalone tBTC
returns to Ethereum through Wormhole and StarkGate as `TRANSFER_RECEIVED`.
Sei is intentionally excluded.

Arbitrum and Base include both legacy address-owner lifecycle events and current
bytes32-owner events from their configured start blocks. Legacy recipients are
left-padded to 32 bytes, matching routed-deposit normalization. Historical
implementations without transfer events still produce lifecycle activity rows.

These are event records, not a unique-transfer count or destination-chain
completion feed. A deposit finalization and its transfer can produce separate
rows in the same transaction. A sent/finalized event does not establish delivery
on the destination chain. `TRANSFER_RECEIVED` proves receipt on Ethereum.
Generic outbound transfers and in-flight returns are outside this feed.

## Completed returns to Ethereum

- Wormhole: the Ethereum Token Bridge's authenticated `TransferRedeemed`
  identifies the source-chain emitter and sequence. Match native tBTC `Transfer`
  logs from that bridge after the completion and before its next completion,
  including non-tBTC completions as boundaries. The optional arbiter payment
  precedes the recipient payment; index one row using the last payout and its
  **net received** amount. Do not count a relayer fee as another arrival.
- StarkGate: subscribe to `Withdrawal(address,address,uint256)` on the configured
  Ethereum bridge and require the token to be tBTC. This event is emitted after
  consuming the proven L2 message and transferring the tokens. Reclaimed deposits
  emit a different event and are not returns from Starknet.
- Transfers to the configured Bitcoin redeemer are excluded from arrival rows.
  Their existing redemption event and source-chain enrichment remain intact.
  Exclusion is per payout, so an ordinary return in the same batch stays visible.
- Amounts are native Ethereum tBTC units (18 decimals). `recipient` is the actual
  Ethereum recipient. Leave `sender` unset: the Ethereum submitter can be a
  relayer and does not establish the source-chain wallet. Source wallet searches
  and pending arrivals would require additional source-chain data.
- Missing receipts/payouts, non-tBTC tokens, malformed or ambiguous payouts, and
  unconfigured bridge contracts do not create arrivals. Unknown Wormhole chain
  IDs retain `Unknown` plus their numeric ID; Sei (32) is excluded explicitly.

`networks.json` pins Ethereum/Sepolia bridge deployments. Start blocks are the
tBTC deployment blocks to include all possible returns, even before the direct
mint hub contracts existed. Mainnet/Sepolia StarkGate addresses were checked via
the corresponding tBTC depositor's `starkGateBridge()` getter.

Sources: [Wormhole completion implementation](https://github.com/wormhole-foundation/wormhole/blob/main/ethereum/contracts/bridge/Bridge.sol),
[Wormhole deployments](https://wormhole.com/docs/products/reference/contract-addresses/),
[StarkGate withdrawal implementation](https://github.com/starknet-io/starkgate-contracts/blob/v2.0.1/src/solidity/StarknetTokenBridge.sol).
The mapping tests include a captured [Arbitrum return](https://etherscan.io/tx/0xcfe55ff31b9481f1cb3992b8cfb58bff9dd0e66504179b97c1d36b50e61bccff).

## Amounts, addresses, and ordering

- `amount`, `initialAmount`, and `tbtcAmount` are tBTC token base units (18
  decimals). `DEPOSIT_INITIALIZED` has no amount; preserve null.
- `recipient` is an EVM address; `recipientBytes32` preserves the destination's
  full address (including Solana and Sui); `starkNetRecipient` is a felt integer.
- `redemptionOutputScriptHash` is a hash: Solidity indexes dynamic `bytes` as
  their keccak256 hash. The actual Bitcoin script remains on `Redemption`.
- `sourceChainId` uses Wormhole IDs, including 10003/10004 for the Arbitrum/Base
  Sepolia spokes. It is not an EVM chain ID.
- `sortKey = (blockNumber << 32) + logIndex` is a unique chronological cursor.
  Page using `orderBy: sortKey`, `orderDirection: desc`, and `sortKey_lt`.
  Timestamp-only pagination can lose multiple events in the same block.

## Inbound source chains

The deployed redeemer event does not contain the source chain. Its successful
transaction also contains the authenticated Token Bridge `TransferRedeemed`
event, which identifies the Wormhole emitter chain, emitter address, and sequence.
The receipt handler reads the redeemer's configured Token Bridge at the indexed
block and matches that contract's log, bounded by the previous redemption from
the same redeemer. It does not infer a chain from a relayer address or from the
token's home chain. Batched redemptions use separate log intervals.

Absent receipts, failed configuration reads, ambiguous/malformed logs, and
unrecognized chain IDs preserve `Unknown`. An unrecognized numeric chain ID is
retained when present. No contract upgrade, call trace, or off-chain API is needed
for this attribution. Historical source metadata is populated when the new
subgraph version reindexes. Existing `Redemption` rows are updated using their
occurrence-suffixed IDs, without creating placeholder redemptions.

## Rollout

1. Merge this change (which incorporates and supersedes PR #6), then build and
   deploy the new subgraph version through the repository's release workflow.
2. Wait for indexing to catch up and check `_meta.hasIndexingErrors` is false.
3. Ensure the threshold-api worker's `SUBGRAPH_GATEWAY_URL_MAINNET` and, where
   used, `SUBGRAPH_GATEWAY_URL_TESTNET` point to the published version. The proxy
   already forwards GraphQL queries and needs no endpoint implementation change.
   If the upstream URL changes, bump `SUBGRAPH_CACHE_KEY_VERSION` or wait for the
   existing cache TTL before checking the new schema.
4. Run the query below against the same `/subgraph/mainnet` or `/subgraph/testnet`
   proxy used by the dapp; ensure known inbound/outbound transaction hashes are
   present and amounts/source chains agree with their Ethereum receipts.
5. Deploy the accompanying threshold-dapp Bridges tab. It reports unavailable
   activity explicitly if the schema has not reached that network's endpoint.

```graphql
query BridgeActivitySmoke {
  _meta { block { number } hasIndexingErrors }
  bridgeActivities(first: 10, orderBy: sortKey, orderDirection: desc) {
    id sortKey type protocol sourceChain sourceChainId destinationChain
    txHash logIndex amount emitterAddress sequence
  }
}
```

## Validation

```sh
yarn install --frozen-lockfile
yarn codegen
yarn test:manifests
yarn test:mappings
yarn build-sepolia
yarn build-mainnet
node --test scripts/check-cutover.test.mjs
```

Mapping tests use Matchstick 0.6.0 and run in CI on Ubuntu 22.04. On newer Apple
Silicon machines unsupported by graph-cli's hardware detection, run the pinned
`binary-macos-12-m1` from the Matchstick 0.6.0 release directly in this repository.
