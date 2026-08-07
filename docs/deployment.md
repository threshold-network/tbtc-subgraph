# Deployment

The subgraph deploys to The Graph Studio. Two independent Studio subgraphs exist, one per
network — `threshold-tbtc-sepolia` (testnet) and `tbtc-mainnet` (production). Each has its own
Studio deploy key; they are not interchangeable.

## Tracks and triggers

| Track    | Studio subgraph          | Workflow                                    | Trigger                    | Gate                                |
| -------- | ------------------------ | -------------------------------------------- | --------------------------- | ------------------------------------ |
| Sepolia  | `threshold-tbtc-sepolia` | `.github/workflows/deploy-sepolia.yaml`      | every push to `master`      | build check (no manual approval)    |
| Mainnet  | `tbtc-mainnet`           | `.github/workflows/deploy-mainnet.yaml`      | push of a `v*` tag          | build check + `production` environment approval |

`ci.yaml` runs on every PR and push to `master`: it builds the manifest against both `sepolia` and
`mainnet` networks (via the reusable `ci-checks.yaml`) as a compile-only gate — this repo has no
lint/test suite, so "does `graph codegen` + `graph build` succeed for both networks" is the
correctness signal.

## Promotion path

1. Merge feature PRs into `master` (gated by `ci.yaml`, matrix over both networks).
2. Every merge to `master` auto-deploys `threshold-tbtc-sepolia` (`deploy-sepolia.yaml`). This is
   the shared staging target — Studio subgraphs cannot be created dynamically per PR via the
   CLI (they're provisioned once via the Studio web UI), so there is no per-PR preview.
3. Cut a release by tagging a commit on `master` and pushing the tag:
   ```
   git tag v1.2.3
   git push origin v1.2.3
   ```
   This triggers `deploy-mainnet.yaml`, which builds/checks against `mainnet`, then pauses on
   the `production` GitHub Environment for manual approval before running `graph deploy` against
   `tbtc-mainnet`. The tag name is used verbatim as the Studio version label.
4. Optionally create a GitHub Release from the tag (`gh release create v1.2.3`) to record what
   shipped — this is a manual step, not automated by CI.

## Required repo configuration (one-time)

- **Secrets** (Settings > Secrets and variables > Actions):
  - `GRAPH_DEPLOY_KEY_SEPOLIA` — deploy key for the `threshold-tbtc-sepolia` Studio subgraph.
  - `GRAPH_DEPLOY_KEY_MAINNET` — deploy key for the `tbtc-mainnet` Studio subgraph. Recommended:
    store this as an **environment secret** on `production` rather than a repo secret, so it's
    only readable by jobs running under that environment.
- **Environment** (Settings > Environments): create `production` and add required reviewers.
  Without a reviewer configured, the environment gate is a no-op and the mainnet deploy runs
  unattended the moment `checks` passes.

## Rollback

- **Mainnet:** re-tag the last-good commit with a new `v*` tag and push it — the workflow is
  tag-driven, so a corrective tag redeploys the known-good manifest/mappings to
  `tbtc-mainnet`. Do not delete or reuse the bad tag.
- **Sepolia:** revert the offending commit on `master` (or push a fix); the next merge redeploys
  automatically. There is no tag gate to re-cut.
- A previous deployment can also be re-promoted directly from the Graph Studio dashboard if a
  redeploy is not immediate.
- Note that a subgraph redeploy only changes what new indexing runs from `startBlock` onward if
  the manifest/mappings changed; it does not retroactively fix already-indexed data other than
  by triggering a full re-sync from the pinned `startBlock` in `networks.json`.

## Networks and addresses

Per-network contract addresses and `startBlock` values live in `networks.json`, the single
source of truth patched into `subgraph.yaml` by `graph build --network <name>` /
`graph deploy --network <name>` at build time (see root `README.md` for the mapping and current
addresses). Do not hand-edit `subgraph.yaml`'s addresses directly — edit `networks.json` instead,
since any local `--network` build overwrites `subgraph.yaml` in place.

**Local builds mutate the tracked file.** `graph build --network <x>` / `graph deploy --network
<x>` rewrite the committed `subgraph.yaml`, not just a `build/` copy. This is harmless inside CI
(each job is a fresh, ephemeral checkout) but means a local build leaves your working tree dirty
with whichever network you last built. Run `git checkout -- subgraph.yaml` after a local build
before committing anything else, so a network swap doesn't slip into an unrelated commit.
