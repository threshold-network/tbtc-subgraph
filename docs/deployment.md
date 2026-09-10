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
and `mainnet` networks (via the reusable `ci-checks.yaml`) as the compile gate for mappings,
and runs the cutover checker's Node tests separately. Sepolia is exercised here purely to
catch multi-network compile regressions; nothing deploys it anywhere.

## Promotion path

**Before pushing a release tag or approving the production deploy**, record the live
deployment hash and its query URL, and store both somewhere access-controlled — this URL
embeds the production gateway API key and must never be pasted into Slack, GitHub issues,
PRs, or other shared/logged locations (no team-wide storage convention is established yet;
see Required repo configuration below). Confirm the Worker uses a published gateway endpoint
pinned to that deployment by following [Consumer cutover](#consumer-cutover) steps 1-3 —
reading the Worker's config alone cannot confirm this, since Worker secrets are write-only.
If production still serves an unpublished Studio version, publish that existing version,
validate its gateway endpoint, and cut the consumer over to it **before deploying a replacement**.

Studio [automatically archives previous unpublished versions when a new version is deployed](https://thegraph.com/docs/en/subgraphs/developing/deploying-publishing/using-subgraph-studio/#automatic-archiving-of-subgraph-versions),
making them unqueryable even if they were receiving production traffic. Keep the currently
served published deployment indexed and queryable throughout the replacement's full re-sync,
and retain it for rollback.

1. Merge feature PRs into `master` (gated by `ci.yaml`, matrix over both networks).
2. Cut a release by tagging a commit on `master` with an **annotated** tag and pushing it:
   ```
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```
   Annotated, not lightweight: the cutover checker (below) reads the tag's own creation
   time to gate its post-tag approval window and still-indexing staleness ceiling. A
   lightweight tag has no creation time of its own -- Git reports the *pointed-to commit's*
   date instead, which would misreport a recovery/rollback release (re-tagging an older
   commit) as however old that commit is.
   This triggers `deploy-mainnet.yaml`, which builds/checks against `mainnet`, then pauses on
   the `production` GitHub Environment for manual approval before running `graph deploy` against
   `tbtc-mainnet`. The tag name is used verbatim as the Studio version label.
3. Wait for the new version to finish indexing in Studio before publishing it. There is
   no graft in `subgraph.yaml`, so every deploy is a **full re-sync from the earliest
   `startBlock` in `networks.json`** (mainnet: block 13,042,356, the TBTC token). That is
   chain head minus that block — over 10M blocks today, with an `eth_call` per revealed
   deposit (src/mappingBridge.ts) plus callHandlers that require block traces — budget
   hours to days, not minutes. Poll the version's own Studio query URL until
   `_meta.block.number` reaches chain head:
   ```
   curl -s -X POST https://api.studio.thegraph.com/query/59264/tbtc-mainnet/v1.2.3 \
     -H 'content-type: application/json' \
     -d '{"query":"{ _meta { block { number } hasIndexingErrors } }"}'
   ```
4. Publish the version to the decentralized network and cut the consumer over — see
   [Consumer cutover](#consumer-cutover), which covers both.
5. Verify through the consumer, not through Studio — see [Verifying a release is live](#verifying-a-release-is-live).
6. Optionally create a GitHub Release from the tag (`gh release create v1.2.3`) to record what
   shipped — this is a manual step, not automated by CI.

> **A Studio deploy is only half a release.** `v0.49.0` (2026-08-07) built and deployed to
> Studio successfully, but the consumer was never repointed at it, so production continued to
> serve the previous deployment — including the `treasuryFee = 0` bug that release fixed. The
> version's Studio URL later became unqueryable, so the release had to be revisited. Steps
> 3-5 and the pre-deploy check above exist to prevent an incomplete release or an interruption
> of the live upstream.

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

1. **Publish the version to the decentralized network** from Studio, following
   [The Graph's publishing procedure](https://thegraph.com/docs/en/subgraphs/developing/deploying-publishing/publishing-a-subgraph/).
   Production must use a published gateway endpoint pinned to the version's
   [deployment ID](https://thegraph.com/docs/en/subgraphs/querying/subgraph-id-vs-deployment-id/)
   (`/deployments/id/<DEPLOYMENT_ID>`). A `/subgraphs/id/<SUBGRAPH_ID>` URL can follow later
   versions automatically, bypassing this manual cutover and rollback procedure.
2. Query that gateway endpoint directly with the `_meta` query in
   [Verifying a release is live](#verifying-a-release-is-live). Wait until it reports the
   intended deployment hash, a block at chain head, and `hasIndexingErrors: false`.
   Network indexers may still be syncing after Studio is ready. Keep production on the
   previous published endpoint until these checks pass.
3. Point the secret at the verified, deployment-pinned gateway URL (run from a `tlabs-xyz/threshold-api`
   checkout; requires Cloudflare access to the `threshold-api` Worker):
   ```
   wrangler secret put SUBGRAPH_GATEWAY_URL_MAINNET --env production
   ```
   [`wrangler secret put` creates a Worker version and deploys it immediately](https://developers.cloudflare.com/workers/configuration/secrets/#via-wrangler),
   so no separate Worker code deployment is needed for cutover or rollback.
4. Responses are cached in the Cloudflare Cache API for `SUBGRAPH_CACHE_TTL_SECONDS`
   (default **30s**), so stale pre-cutover responses drain on their own within a minute. To
   drop them immediately instead, bump `SUBGRAPH_CACHE_KEY_VERSION` (default `v1`) in
   `[env.production.vars]` in `wrangler.toml` as an intentional, reviewed Worker configuration
   release. Reserve `bun run deploy:production` for such code/configuration releases: it uploads
   the local checkout's Worker code and configuration.

Repeat with `--env staging` if the staging Worker should track the same version.

**Breaking changes.** The Worker forwards GraphQL verbatim and does not validate against a
schema, so a schema change that removes or renames a field surfaces as a query error in the
dApp at cutover, not at deploy. Coordinate a dApp explorer release before cutting over when a tag
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

Confirm 1 and 2 always; confirm 3 for a schema-changing release, substituting the value
spot-check below for a value-only fix.

1. `_meta.deployment` matches the intended deployment hash from the deploy job's
   `Build completed: Qm...` line. (The job's `Deployed to ...` line is only the Studio dashboard
   URL, not the hash.) When migrating the existing live version to a published endpoint in
   the pre-deploy check, this must still be the recorded pre-migration hash.
2. `_meta.block.number` is at chain head and `hasIndexingErrors` is `false`.
3. A field introduced by the release actually resolves. A schema addition is the
   cheapest positive signal that the new mappings are live — e.g. after a release that
   adds `isRouted` and `destinationOwner` to the `Deposit` entity,
   `{ deposits(first:1, where:{isRouted:true}) { id destinationOwner } }` returns data
   instead of an error indicating the field doesn't exist on `Deposit`.

For a release that fixes indexed *values* rather than the schema, spot-check a record the fix
was supposed to correct — e.g. for the `treasuryFee` fix, an old swept deposit should report a
non-zero fee rather than `0`.

### Automated check

`cutover-check.yaml` runs `scripts/check-cutover.mjs` every 6 hours to detect a missed cutover.
It compares `_meta.deployment` from Studio (for the selected release tag) against
`_meta.deployment` from the proxy, and needs no credentials.

Release selection checks three sources in order:
1. `RELEASE_TAG` (env var, or the workflow's `release_tag` input) — an explicit override, always
   wins. Must match `vX.Y.Z`; anything else fails the check before contacting either endpoint.
2. `RELEASE_POINTER` — a committed file at the repo root holding a single `vX.Y.Z` tag. Absent
   by default (tag order alone is correct for a normal release); operators create/update it only
   during a rollback, per [Rollback](#rollback). Malformed content fails the check rather than
   being silently ignored.
3. Otherwise, the highest strictly release-shaped `v*` tag (must match `vX.Y.Z`; pre-release
   tags like `v1.4.0-rc1` are excluded so they can't outrank `v1.4.0` under Git's version sort)
   using Git's descending version order (`git tag --list 'v*' --sort=-version:refname
   --no-column`), across all fetched tags regardless of commit ancestry or tag dates. For
   example, `v1.10.0` sorts above `v1.9.0`. Recovery and rollback releases must increase the
   version even when reusing the same commit or an older commit.

It cannot run as a post-deploy step — a full re-sync outlasts any job — so it polls instead,
and stays green while a healthy new version is still indexing, reporting progress. Indexing
errors on either endpoint fail the check before comparing hashes or sync progress. It reports:

| State                                           | Result                                      |
| ----------------------------------------------- | ------------------------------------------- |
| Either endpoint reports indexing errors         | **fail** — unhealthy deployment              |
| Healthy hashes match                            | pass — the release is live                  |
| Healthy Studio still indexing (lagging >300 blocks behind proxy) | pass — cutover not due yet, prints progress |
| Healthy Studio still indexing past the staleness ceiling | **fail** — sync appears stalled, not merely catching up |
| Healthy Studio caught up (within 300 blocks) but hash mismatch | **fail** — cutover pending                   |
| Studio version no longer resolves               | **fail** — check missing or archived version |
| Studio deployment not found, but the tag is within the post-tag approval grace window | pass — not yet a failure |
| Either endpoint unreachable or malformed         | **fail**                                    |

> **Note**: The threshold of 300 blocks is configured via the `SYNC_LAG_TOLERANCE_BLOCKS` constant in `scripts/check-cutover.mjs`.
> **Note**: The post-tag approval grace window (`TAG_APPROVAL_GRACE_SECONDS`, default 2 hours) and the still-indexing staleness ceiling (`STILL_INDEXING_CEILING_SECONDS`, default 7 days) are also configured in `scripts/check-cutover.mjs`, and both are validated as non-negative integers -- a malformed override fails the check immediately rather than silently disabling the comparison. Both gates require the release tag to be **annotated** (see [Promotion path](#promotion-path)); a lightweight tag, or one git can't resolve (e.g. unfetched), skips both checks and keeps the check's original behavior for that outcome, rather than guessing.
> **Note**: Because `v0.49.0` is the only existing git tag and its Studio version is already archived, the first scheduled run of this check after this PR merges will report **fail** (Studio version no longer resolves). This is expected and will be resolved by cutting and shipping a new release tag (which will create a new Studio version) or by explicitly accepting the red state until then.

Progress is relative to the proxy's indexed block, not an independent chain-head check.
A pending cutover still requires publishing and validating the deployment-pinned gateway URL
as described in [Consumer cutover](#consumer-cutover), before updating the Worker secret.

Run it locally the same way, against whatever tag you care about:

```
node scripts/check-cutover.mjs                  # highest version v* tag
RELEASE_TAG=v1.2.3 node scripts/check-cutover.mjs
```

Or trigger it from the Actions tab (`Cutover Check` > Run workflow) with an optional tag.

Run the isolated regression tests with `node --test scripts/check-cutover.test.mjs`. They use
temporary Git repositories and mocked responses, need no dependencies, and run in `ci.yaml`.

## Required repo configuration (one-time)

- **Secrets** (Settings > Secrets and variables > Actions):
  - `GRAPH_DEPLOY_KEY_MAINNET` — deploy key for the `tbtc-mainnet` Studio subgraph. Recommended:
    store this as an **environment secret** on `production` rather than a repo secret, so it's
    only readable by jobs running under that environment.
- **Environment** (Settings > Environments): create `production` and add required reviewers.
  Without a reviewer configured, the environment gate is a no-op and the mainnet deploy runs
  unattended the moment `checks` passes.
- The wallet/account authorized to publish `tbtc-mainnet` to The Graph's decentralized
  network is the same Studio account that holds `GRAPH_DEPLOY_KEY_MAINNET` above — no
  separate publish credential exists.
- The production gateway API key (embedded in the query URL, used to construct
  authenticated query URLs) is issued by The Graph's gateway per query key and has **no
  established storage location yet** — decide on one and record it here before relying on
  this runbook for a release.

Note that the consumer-side credential is **not** in this repo: the `SUBGRAPH_GATEWAY_URL_*`
secrets live on the `threshold-api` Cloudflare Worker and are set with `wrangler secret put`.
Whoever cuts a release needs Cloudflare access to that Worker, or must hand the entire Consumer
cutover procedure to someone who has it.

## Rollback

- If the previous published deployment is still synced and reachable, validate its retained,
  deployment-pinned gateway URL and restore it with `wrangler secret put` as described in
  [Consumer cutover](#consumer-cutover). This activates the rollback without a re-sync or a
  separate Worker code deployment. Verify the previous deployment hash through the proxy
  with the cache bypass described above.
- If the previous deployment is unavailable, follow the pre-deploy check in
  [Promotion path](#promotion-path), then re-tag the last-good commit with a new `v*` tag
  and push it. The workflow redeploys the known-good manifest/mappings to `tbtc-mainnet`;
  wait for syncing, publish, validate the gateway endpoint, and cut the consumer over as
  for a release. Doing the pre-deploy check here keeps the current, faulty deployment
  queryable as a safety net during the fix's re-sync (and is a no-op if that deployment
  is already published). Do not delete or reuse the bad tag. A Studio redeploy or
  dashboard promotion alone does not change the Worker's pinned upstream.
- Note that a subgraph redeploy only changes what new indexing runs from `startBlock` onward if
  the manifest/mappings changed; it does not retroactively fix already-indexed data other than
  by triggering a full re-sync from the pinned `startBlock` in `networks.json`.
- Update `RELEASE_POINTER` (create it if absent, commit and push the intended live tag) as part
  of either rollback path above. `scripts/check-cutover.mjs` reads this file first, before
  falling back to git tag order — without it, tag-order inference cannot represent a rollback
  to an older release and will misreport a pending cutover back toward the version just rolled
  away from. Normal operation ships with **no** `RELEASE_POINTER` file; tag order alone is the
  correct signal until a rollback happens.
- Remove `RELEASE_POINTER` (commit and push the deletion) once a subsequent forward release
  supersedes the rollback and reaches production. A file left in place after that point would
  silently keep pinning every future check to the rollback target instead of the current
  release, defeating the check's purpose.

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
