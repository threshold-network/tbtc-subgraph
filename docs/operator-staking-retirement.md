# Operator staking retirement

Economic node staking is retired. The WalletRegistry's DAO-managed allowlist
uses authorization weights without requiring token stakes; see the
[Allowlist contract documentation](https://github.com/threshold-network/keep-core/blob/main/solidity/ecdsa/docs/Allowlist.md).
Application slashing events remain useful fault signals. Their reported amounts
can be symbolic after TIP-100 and must not be presented as current token losses.

This change removes legacy TokenStaking balance and role indexing on both
configured networks. It preserves application registration and authorization
events, operators keyed by staking-provider address, group public keys, DKG
memberships (including repeated seats), wallet records, rewards, relay history,
and the fault handlers already implemented in this subgraph. It does not add
coverage for previously empty fault handlers.

The TokenStaking source is reduced to `TokenStakingTelemetry`, a single-event
ABI and handler for `TokensSeized`. Its address and historical start block are
unchanged. Each signal retains its raw amount and discrepancy flag, attaches to
the provider's event history, and never changes authorization weights, rewards,
or application fault counters. `Event.contract` records the emitter, since
`transaction.to` does not identify the emitting contract. For this source,
`isRandomBeaconEvent` is false; use `contract` to identify the source, not that
legacy boolean to infer which application initiated a seizure.

## Breaking GraphQL changes

| Removed field or value | Replacement or interpretation |
| --- | --- |
| `Operator.stakedAmount`, `stakedAt`, `stakeType` | No current economic node stake; no replacement balance |
| `Operator.owner`, `beneficiary`, `authorizer` | Retired TokenStaking roles; query the old deployment for history |
| `Operator.registeredOperatorAddress`, `isBondRegisteredOperatorAddress` | `walletRegistryOperator`, `randomBeaconOperator`, and first indexed `registeredAt`; repeated registration is not a count of bonded nodes |
| `Operator.tBTCAuthorizedAmount` | `tBTCAuthorizationWeight` |
| `Operator.randomBeaconAuthorizedAmount` | `randomBeaconAuthorizationWeight` |
| `StatsRecord.totalTBTCAuthorizedAmount` | `totalTBTCAuthorizationWeight` |
| `StatsRecord.totalRandomBeaconAuthorizedAmount` | `totalRandomBeaconAuthorizationWeight` |
| `StatsRecord.numOperators`, `numOperatorsRegisteredNode`, `totalStaked` | Removed obsolete stake/bond statistics |
| `TransactionEvent.STAKED`, `TOPUP`, `UNSTAKE`, `BOND_OPERATOR`, `AUTHORIZED_UNKNOW` | Removed legacy stake events or unused values |

`Operator.address` remains the most recently observed registered/joined address.
Use the application-specific fields when the two applications use different
operator addresses. Operators can be created by registration, membership,
authorization, rewards, or telemetry without a preceding stake event.

Authorization weights are the **latest reported callback values**, including
pending decrease requests, as in the previous indexing behavior. The booleans
mean that value is nonzero; they are not a contract eligibility check or proof
that a requested decrease has finalized. Historical callback values may still
use token-era units. Do not scale these fields as T balances or assume every
provider has migrated. Aggregate weights replace the previously indexed value
with each reported absolute value, avoiding double counting when a migration
callback reports `fromAmount = 0` over an existing historical value.

`Operator.totalSlashedAmount` and `RandomBeaconGroup.totalSlashedAmount` retain
raw application-event sums for historical compatibility. Their units/meaning
follow the emitting contract at that block. Do not add `TokensSeized` amounts to
these counters, since a single fault may emit both signals.

User rebate staking is separate. The `RebateStaker`, `RebateStakingEvent`, and
`RebateStakingStats` additions in [PR #24](https://github.com/threshold-network/tbtc-subgraph/pull/24)
are unaffected. This cleanup is independently based on `master` and may be
merged before or after that feature.

## Release and consumer checks

Follow the [deployment runbook](deployment.md), including retaining the previous
published deployment and its deployment-pinned gateway URL before deploying a
replacement. The new schema requires a full re-sync; do not graft incompatible
entities. Legacy stake balances/events will not appear in the new deployment.
Keep the previous published deployment queryable for rollback and any historical
stake queries that still need those fields.

Before consumer cutover:

1. Inventory actual GraphQL clients. The API Worker forwards queries verbatim,
   so removing fields produces errors for a client still requesting them.
   Deprecated tbtcscan operator queries use the removed fields and must remain
   pinned to the historical deployment if retained. The active Explorer's
   wallet fallback uses group/public-key fields that this cleanup preserves.
2. Remove the unused Explorer `GET_GROUP_DETAIL_QUERY`, which requests legacy
   stake fields and a nonexistent membership `weight` field. It has no runtime
   caller. No new operator-weight query is needed by the current Explorer.
3. If shipping the Explorer rebate migration, include PR #24 in the released
   subgraph and satisfy the cutover requirements in
   [dApp PR #453](https://github.com/tlabs-xyz/threshold-dapp/pull/453).
4. Wait for full indexing, publish, verify the gateway's deployment hash, chain
   head, and `hasIndexingErrors: false`, then repoint the proxy. Spot-check through
   the proxy that operators resolve `walletRegistryOperator`, `registeredAt`, and
   `tBTCAuthorizationWeight`; exercise the Explorer's group-based wallet fallback.

Merging this cleanup does not itself deploy or switch production traffic.
