# Treasury fee divisor at reveal

`Deposit.treasuryFeeDivisorAtReveal` snapshots the divisor from `BridgeState`
when `DepositRevealed` is handled. `DepositParametersUpdated` changes that state
in event order. A contract call from the reveal handler would instead read the
state at the end of the block, including any later governance update.

The initial value is **2000**, set by `Bridge.initialize` without emitting
`DepositParametersUpdated`. The proxy does emit `Initialized(1)`, which seeds
the state. Both configured Bridge data sources start at that deployment block:

| Network | Bridge start block | Initialization evidence | Initializer source |
| --- | --- | --- | --- |
| Mainnet | 16397413 | [Proxy receipt, `Initialized(1)`](https://github.com/threshold-network/tbtc-v2/blob/8a816122aaacc342c90ee2fd77f8ba403bc8431d/solidity/deployments/mainnet/Bridge.json#L2619-L2628) | [Divisor = 2000](https://github.com/threshold-network/tbtc-v2/blob/8a816122aaacc342c90ee2fd77f8ba403bc8431d/solidity/contracts/bridge/Bridge.sol#L304) |
| Sepolia | 4553028 | [Proxy receipt, `Initialized(1)`](https://github.com/threshold-network/tbtc-v2/blob/5628b077cb5d9bb60881e9d50d2ebbcfe70d173f/typescript/src/lib/ethereum/artifacts/sepolia/Bridge.json#L2619-L2628) | [Divisor = 2000](https://github.com/threshold-network/tbtc-v2/blob/5628b077cb5d9bb60881e9d50d2ebbcfe70d173f/solidity/contracts/bridge/Bridge.sol#L304) |

Later initialization versions do not reset the value. An already tracked value,
including zero, also survives initialization handling. If indexing begins after
initialization without a seed, the divisor remains null until a parameter update
is indexed; it is never guessed from end-of-block state. When adding a new Bridge
deployment, verify its initializer and include its deployment block in the manifest.

For example, if the current divisor is zero and a block contains a reveal,
an update to 500, then another reveal, the deposits retain zero and 500
respectively. Further updates leave both snapshots unchanged.

This change requires a re-sync to populate historical deposits. Bundle deployment
with the next release as planned for PR #23.

Run the handler regression tests with:

```sh
node --experimental-vm-modules --test scripts/check-deposit-divisor.test.mjs
```

The tests execute the mapping handlers with mocked Graph services. Code generation
and builds for both networks separately check AssemblyScript and schema compatibility.
