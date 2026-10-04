# Rebate staking

The additive `RebateStaker`, `RebateStakingEvent`, and `RebateStakingStats`
entities replace the Explorer's reads from the deprecated tbtc-v3-indexer.
They index the mainnet RebateStaking proxy at
`0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45`, from its deployment block
**23,598,704**. The address, block, and event ABI come from the canonical
[mainnet deployment artifact](https://github.com/threshold-network/tbtc-v2/blob/main/solidity/deployments/mainnet/RebateStaking.json).
This starts earlier than the old indexer's configured block and retains the
initial staking history. These entities are separate from operator TokenStaking.

Sepolia has no known RebateStaking deployment. Its source uses the zero address
and is compile-checked only, following the existing disabled-source convention.

## Semantics

- Stake and pending unstake amounts are T wei (18 decimals). Pending stake remains
  in `stakedAmount` and global `totalStaked` until `UnstakeFinished`.
- `UnstakeStarted` replaces the pending amount; repeated requests do not accumulate.
- Rebate amounts and totals are satoshis (8 decimals). Totals count lifetime
  `RebateReceived` awards, including canceled requests, matching the previous API.
  They are not net settled rebates or current rolling-window usage.
- `RebateCanceled` records the original `requestedAt` and has no amount: the event
  itself does not carry the canceled rebate value.
- Transfers move stake and pending requests. Historical awards remain attributed
  to their recipient. Both addresses receive a timeline record for the transfer.
- `totalStakers` counts addresses encountered, including transfer recipients;
  `activeStakers` counts addresses with positive stake, including pending stake.
- Entity IDs include transaction hash, log index, and staker. `sequence` orders
  events by block and log index, so the latest 100 events can be queried without
  a timestamp tie breaking events within the same block.

Run `yarn codegen`, `yarn test`, and both network builds. Matchstick 0.6.0 runs
the contract-behavior regressions locally on macOS and in CI on Ubuntu 22.04.

## Explorer cutover

Follow the full [deployment and consumer cutover procedure](deployment.md).
The frontend must remain on its current version until all these steps pass:

1. Deploy, fully sync, and publish the updated subgraph. Retain the currently
   served published deployment throughout the re-sync for continuity and rollback.
2. Update the threshold-api production Worker's `SUBGRAPH_GATEWAY_URL_MAINNET`
   secret to the verified published gateway URL pinned to the new deployment.
   Studio deployment alone does not update the public proxy.
3. Run this query through `https://api.threshold.network/subgraph/mainnet` with
   the `x-cache-bypass: true` header:

   ```graphql
   {
     _meta { deployment block { number } hasIndexingErrors }
     rebateStakingStats(id: "global") {
       totalStakers activeStakers totalStaked totalRebatesDistributed
     }
     rebateStakers(first: 5, where: { stakedAmount_gt: "0" }) {
       id stakedAmount pendingUnstakeAmount eventCount totalRebatesReceived
     }
     rebateStakingEvents(first: 5, orderBy: sequence, orderDirection: desc) {
       id eventType amount timestamp transactionHash
     }
   }
   ```

   Confirm the expected deployment, a recent block, no indexing errors, and
   representative stakers' balances and pending requests against on-chain
   `getStake`/`stakes` at the same block. Compare same-transaction rebate logs
   and initial staking history against chain events, not the stale indexer.
4. Release the dependent dApp PR. Check the global staking table, wallet timeline,
   and deposit fee waivers in production, including a wallet with no stake.

No replacement indexer deployment or new Worker route is required. Leave the
custom indexer deprecated. A frontend rollback also requires a proxy version
that supports whichever schema that frontend expects.
