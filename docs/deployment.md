# Deployment

The subgraph deploys to The Graph Studio. One Studio subgraph exists — `tbtc-mainnet`
(production) — with its own Studio deploy key.

Sepolia is **not deployed** to Studio: it's compile-checked only (see below), since there's no
known consumer of a sepolia Studio subgraph and only a mainnet deploy key exists. If a sepolia
deploy is needed later, provision a `threshold-tbtc-sepolia` Studio subgraph, get its deploy
key, and reintroduce a `deploy-sepolia.yaml` workflow mirroring `deploy-mainnet.yaml`'s shape
(minus the `production` environment gate, matching whatever staging policy is decided then).

## Tracks and triggers

| Track    | Studio subgraph | Workflow                                | Trigger              | Gate                                             |
| -------- | --------------- | ---------------------------------------- | --------------------- | ------------------------------------------------ |
| Mainnet  | `tbtc-mainnet`  | `.github/workflows/deploy-mainnet.yaml`  | push of a `v*` tag     | build check + `production` environment approval  |

`ci.yaml` runs on every PR and push to `master`: it builds the manifest against both `sepolia`
and `mainnet` networks (via the reusable `ci-checks.yaml`) as a compile-only gate — this repo
has no lint/test suite, so "does `graph codegen` + `graph build` succeed for both networks" is
the correctness signal. Sepolia is exercised here purely to catch multi-network compile
regressions; nothing deploys it anywhere.

## Promotion path

1. Merge feature PRs into `master` (gated by `ci.yaml`, matrix over both networks).
2. Cut a release by tagging a commit on `master` and pushing the tag:
   ```
   git tag v1.2.3
   git push origin v1.2.3
   ```
   This triggers `deploy-mainnet.yaml`, which builds/checks against `mainnet`, then pauses on
   the `production` GitHub Environment for manual approval before running `graph deploy` against
   `tbtc-mainnet`. The tag name is used verbatim as the Studio version label.
3. Wait for the new version to finish indexing in Studio before doing anything else. There is
   no graft in `subgraph.yaml`, so every deploy is a **full re-sync from the earliest
   `startBlock` in `networks.json`** (mainnet: block 13,042,356, the TBTC token). That is
   ~13M blocks with call handlers that make `eth_call`s per sweep — budget hours to days, not
   minutes. Poll the version's own Studio query URL until `_meta.block.number` reaches chain
   head:
   ```
   curl -s -X POST https://api.studio.thegraph.com/query/59264/tbtc-mainnet/v1.2.3 \
     -H 'content-type: application/json' \
     -d '{"query":"{ _meta { block { number } hasIndexingErrors } }"}'
   ```
4. **Cut the consumer over to the new version** — see [Consumer cutover](#consumer-cutover).
   Deploying to Studio does not change what `api.threshold.network` serves. Skipping this step
   means the release is invisible in production.
5. Verify through the consumer, not through Studio — see [Verifying a release is live](#verifying-a-release-is-live).
6. Optionally create a GitHub Release from the tag (`gh release create v1.2.3`) to record what
   shipped — this is a manual step, not automated by CI.

> **A Studio deploy is only half a release.** `v0.49.0` (2026-08-07) built and deployed to
> Studio successfully, but the consumer was never repointed at it, so production continued to
> serve the previous deployment — including the `treasuryFee = 0` bug that release fixed. The
> unqueried Studio version was later no longer resolvable (Studio archives versions that
> receive no traffic), so the work had to be redone. Steps 3-5 exist to prevent that.

## Consumer cutover

The only known consumer of this subgraph is the **`api.threshold.network` Cloudflare Worker**
in [`tlabs-xyz/threshold-api`](https://github.com/tlabs-xyz/threshold-api), which proxies
`POST /subgraph/:network` to whatever URL is configured for that network. The dApp explorer
talks to that proxy, never to Studio directly. The Worker resolves the upstream from two
secrets:

| Network   | Worker secret                   |
| --------- | ------------------------------- |
| `mainnet` | `SUBGRAPH_GATEWAY_URL_MAINNET`  |
| `testnet` | `SUBGRAPH_GATEWAY_URL_TESTNET`  |

These are **secrets, not `wrangler.toml` vars** — they are invisible in the repo, so a stale
value cannot be spotted by reading the config. An unset secret makes the proxy return 400 for
that network.

Once the new Studio version has fully synced:

1. Point the secret at the new version's query URL (run from a `tlabs-xyz/threshold-api`
   checkout; requires Cloudflare access to the `threshold-api` Worker):
   ```
   wrangler secret put SUBGRAPH_GATEWAY_URL_MAINNET --env production
   ```
2. Redeploy the Worker so the change takes effect:
   ```
   bun run deploy:production
   ```
3. Responses are cached in the Cloudflare Cache API for `SUBGRAPH_CACHE_TTL_SECONDS`
   (default **30s**), so stale pre-cutover responses drain on their own within a minute. To
   drop them immediately instead, bump `SUBGRAPH_CACHE_KEY_VERSION` (default `v1`) in
   `[env.production.vars]` in `wrangler.toml` and redeploy.

Repeat with `--env staging` if the staging Worker should track the same version.

**Prefer publishing to the decentralized network** over leaving a release only in Studio. A
Studio version that nothing queries can be archived, which is what happened to `v0.49.0`. If
the release is published from Studio to the network and the Worker secret points at the
resulting gateway URL, the deployment is not subject to Studio archiving.

**Breaking changes.** The Worker forwards GraphQL verbatim and does not validate against a
schema, so a schema change that removes or renames a field surfaces as a query error in the
dApp at cutover, not at deploy. Coordinate a consumer release before cutting over when a tag
contains one.

## Verifying a release is live

Check the **proxy**, not Studio — Studio answering correctly says nothing about what production
serves. `x-cache-bypass: true` skips the Worker's response cache (`?cache=skip` and
`Cache-Control: no-cache` work too):

```
curl -s -X POST https://api.threshold.network/subgraph/mainnet \
  -H 'content-type: application/json' -H 'x-cache-bypass: true' \
  -d '{"query":"{ _meta { deployment block { number } hasIndexingErrors } }"}'
```

Confirm all three:

1. `_meta.deployment` is the deployment hash the deploy job's `Build completed: Qm...` line
   printed, and **not** the hash that was live before the cutover. (The job's `Deployed to ...`
   line is only the Studio dashboard URL, not the hash.)
2. `_meta.block.number` is at chain head and `hasIndexingErrors` is `false`.
3. A field or entity introduced by the release actually resolves. A schema addition is the
   cheapest positive signal that the new mappings are live — e.g. after a release that adds
   `routedDeposits`, `{ routedDeposits(first:1) { id } }` returns data instead of
   `Type 'Query' has no field 'routedDeposits'`.

For a release that fixes indexed *values* rather than the schema, spot-check a record the fix
was supposed to correct — e.g. for the `treasuryFee` fix, an old swept deposit should report a
non-zero fee rather than `0`.

### Automated check

`cutover-check.yaml` runs `scripts/check-cutover.mjs` every 6 hours and **fails while the
latest `v*` tag is not what the proxy serves**, so a forgotten cutover surfaces as a red
workflow instead of staying invisible. It compares `_meta.deployment` from Studio (for that
tag) against `_meta.deployment` from the proxy, and needs no credentials.

It cannot run as a post-deploy step — a full re-sync outlasts any job — so it polls instead,
and stays green while the new version is still indexing, reporting progress. It reports:

| State                                                | Result                                        |
| ---------------------------------------------------- | --------------------------------------------- |
| Hashes match                                          | pass — the release is live                    |
| Studio still indexing                                 | pass — cutover not due yet, prints progress   |
| Studio synced, proxy serves something else            | **fail** — cutover pending                    |
| Studio version no longer resolves                     | **fail** — archived; re-tag and re-sync       |
| Either endpoint unreachable                           | **fail**                                      |

Run it locally the same way, against whatever tag you care about:

```
node scripts/check-cutover.mjs                  # latest v* tag
RELEASE_TAG=v1.2.3 node scripts/check-cutover.mjs
```

Or trigger it from the Actions tab (`Cutover Check` > Run workflow) with an optional tag.

## Required repo configuration (one-time)

- **Secrets** (Settings > Secrets and variables > Actions):
  - `GRAPH_DEPLOY_KEY_MAINNET` — deploy key for the `tbtc-mainnet` Studio subgraph. Recommended:
    store this as an **environment secret** on `production` rather than a repo secret, so it's
    only readable by jobs running under that environment.
- **Environment** (Settings > Environments): create `production` and add required reviewers.
  Without a reviewer configured, the environment gate is a no-op and the mainnet deploy runs
  unattended the moment `checks` passes.

Note that the consumer-side credential is **not** in this repo: the `SUBGRAPH_GATEWAY_URL_*`
secrets live on the `threshold-api` Cloudflare Worker and are set with `wrangler secret put`.
Whoever cuts a release needs Cloudflare access to that Worker, or needs to hand step 4 to
someone who has it.

## Rollback

- Re-tag the last-good commit with a new `v*` tag and push it — the workflow is tag-driven, so a
  corrective tag redeploys the known-good manifest/mappings to `tbtc-mainnet`. Do not delete or
  reuse the bad tag.
- A previous deployment can also be re-promoted directly from the Graph Studio dashboard if a
  redeploy is not immediate.
- Either way the rollback is not live until the consumer points at it: re-run
  [Consumer cutover](#consumer-cutover) against the rolled-back version's URL. If the previous
  version is still synced and reachable, repointing the Worker secret back at it is the fastest
  rollback available, since it needs no re-sync.
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
