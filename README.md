# tBTC subgraph v2

Provide insight into the workings of the Threshold tBTC system - deposits, redemptions, signers, governance actions, etc

## Deployment

See [docs/deployment.md](docs/deployment.md) for the CI/CD pipeline, promotion path, and
required one-time setup. For local/manual builds and deploys, see the `scripts` section of
[package.json](package.json).

## Contracts

Per-network contract addresses and `startBlock` values are tracked in
[networks.json](networks.json), the single source of truth patched into `subgraph.yaml` at
build time.
