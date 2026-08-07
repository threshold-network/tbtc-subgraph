---
title: Subgraph CI/CD Pipeline
date: 2026-08-07
status: ready
tags: [ci-cd, subgraph, github-actions, deployment, graph-studio]
---

# Subgraph CI/CD Pipeline

## Problem Statement

There is no automated pipeline for this subgraph. Every deploy — sepolia or mainnet — is a
manual, local `graph-cli` invocation by whoever happens to have Studio access on their machine.
Nothing validates that the manifest compiles before a human runs `graph deploy`. There is no
versioned release history: mainnet deploys leave no record of what was shipped or when. A
mistake in a manual mainnet deploy has no gate — it goes straight to the Studio subgraph other
consumers query. Separately, `README.md`'s deploy instructions describe a dead `goerli` network
and a deprecated `--product hosted-service` auth flow, so a new contributor following it hits a
wall immediately.

## Solution

An automated build-gate-and-deploy pipeline via GitHub Actions, modeled on
`tlabs-xyz/vba-dashboard`'s workflow structure:

- Every PR and every push to `master` runs a compile-only gate against both networks (sepolia
  and mainnet), so a broken manifest or mapping is caught before merge.
- Every merge to `master` auto-deploys the `threshold-tbtc-sepolia` Studio subgraph — testnet
  always reflects what's on `master`, no separate action required.
- A mainnet release is an explicit, versioned act: pushing a `v*` git tag triggers a build gate,
  then pauses for manual approval in a GitHub Environment before deploying `tbtc-mainnet`.
- Dependency vulnerabilities in this repo's own manifest are scanned on PRs (diff-aware) and on
  pushes to `master` (full scan).
- `README.md` points at the canonical deployment doc instead of carrying stale, contradictory
  instructions.

## User Stories

1. As a contributor, I want my PR to fail fast if the subgraph doesn't compile for either
   network, so that I don't merge a broken manifest.
2. As a maintainer, I want every merge to `master` to auto-deploy to the sepolia Studio
   subgraph, so that testnet always reflects what's on `master` without a manual step.
3. As a release manager, I want to cut a mainnet release by pushing a version tag, so that
   production deploys are versioned and reproducible.
4. As a release manager, I want the mainnet deploy to pause for my explicit approval, so that a
   bad tag can't silently reach the production consumers already querying `tbtc-mainnet`.
5. As an on-call engineer, I want a documented rollback procedure, so that I can recover quickly
   if a deploy misbehaves.
6. As a security-conscious maintainer, I want dependency vulnerabilities introduced by this
   repo's own manifest changes flagged on PRs, so that supply-chain risk doesn't creep in
   unnoticed.
7. As a maintainer watching `master`, I want a full (non-diff-aware) vulnerability scan on every
   push, so that a newly-published advisory against an existing dependency still surfaces even
   without a PR touching the lockfile.
8. As a new contributor, I want the README to describe the current deploy flow — not `goerli` or
   `hosted-service` — so that I don't follow dead instructions.
9. As a maintainer setting this up, I want a clear list of one-time setup steps (secrets,
   environment reviewers), so I know exactly what's required before the pipeline can run for
   real.
10. As a maintainer, I want the mainnet and sepolia Studio deploy keys to be distinct secrets, so
    that a lower-stakes credential can't reach the production subgraph.
11. As a reviewer, I want a Studio deploy to retry a few times before failing the workflow, so
    that transient IPFS/Studio flakiness doesn't demand a manual re-run for every hiccup.
12. As a maintainer, I want the workflows to target the repo's actual default branch (`master`),
    so triggers fire correctly rather than silently never matching.

## Implementation Decisions

**Workflow files** (`.github/workflows/`):

- `ci-checks.yaml` — reusable (`workflow_call`), takes a `network` input. Installs deps
  (`yarn install --frozen-lockfile`), runs `yarn codegen`, then `yarn run build-<network>`. This
  is the sole correctness gate: the repo has no lint or test suite, so "does codegen + build
  succeed for this network" is the signal.
- `ci.yaml` — triggers on `pull_request` and `push` to `master`. Matrix over
  `network: [sepolia, mainnet]`, each leg calling `ci-checks.yaml`.
- `deploy-sepolia.yaml` — triggers on `push` to `master`. `checks` job (network: sepolia) then
  `deploy` job, no approval gate. Deploy job independently checks out, installs, runs `codegen`,
  then `npx --no-install graph deploy --studio threshold-tbtc-sepolia --deploy-key <key>
  --version-label <label> --network sepolia`.
- `deploy-mainnet.yaml` — triggers on `push` of a `v*` tag. `checks` job (network: mainnet) then
  a `deploy` job scoped to the `production` GitHub Environment (requires manual reviewer
  approval before the job starts), running the equivalent `graph deploy --studio tbtc-mainnet`
  invocation.
- `osv-scan.yaml` — new. Mirrors `vba-dashboard`'s pattern using the
  `google/osv-scanner-action` reusable workflows (pinned to the same commit SHA vba-dashboard
  uses): diff-aware scan on `pull_request` (fails only on vulnerabilities the PR introduces),
  full scan on `push` to `master`. Points `--lockfile` at `./yarn.lock` instead of
  `pnpm-lock.yaml`. Deny-all top-level `permissions: {}`, with each job granting only what the
  reusable workflow's declared ceiling requires (`actions: read`, `contents: read`,
  `security-events: write`; SARIF upload disabled since this repo has no code-scanning setup to
  receive it).

**Cross-cutting decisions:**

- Default branch is `master`, not `main` — confirmed via the GitHub API (`gh api
  repos/.../GET` → `default_branch: master`). Every trigger and doc reference uses `master`.
  This mattered: workflows first drafted against `main` would never have fired.
- Third-party actions pinned to full commit SHA with a version comment (`actions/checkout`,
  `actions/setup-node`, `google/osv-scanner-action`'s reusable workflows), matching
  `vba-dashboard`'s supply-chain hygiene bar. Same SHAs reused where the same action version
  applies.
- Node 22, pinned to major version only (`'22'`) rather than an exact minor/patch — this repo
  has no `.nvmrc` or `engines` field to match against, and pinning tighter than that adds
  maintenance cost for no benefit here.
- Retry policy on Studio deploys: 3 attempts, sleeping `attempt * 15` seconds between retries
  (15s, 30s), scoped to the `graph deploy` step only — build/codegen failures fail immediately
  since retrying a deterministic compile error is pointless.
- Version label scheme: sepolia deploys use `master-<short-sha>` (e.g. `master-e5606a6`);
  mainnet deploys use the pushed tag name verbatim (e.g. `v1.2.3`) via `github.ref_name`.
- Concurrency: `cancel-in-progress: true` for the `ci.yaml` compile gate (stale runs are cheap
  to discard); `cancel-in-progress: false` for both deploy workflows (never cancel a `graph
  deploy` mid-flight — queue instead of racing two deploys against the same Studio subgraph).
- Secrets: `GRAPH_DEPLOY_KEY_SEPOLIA` as a repo-level secret; `GRAPH_DEPLOY_KEY_MAINNET` as an
  environment-scoped secret on `production`, not a repo secret — Studio deploy keys are scoped
  per-subgraph (confirmed: sepolia and mainnet are separate Studio subgraphs, each with its own
  key), and scoping the mainnet key to the `production` environment means only a job that has
  passed the environment's approval gate can ever read it.
- `yarn.lock` was gitignored (no lockfile committed at all); un-ignored and committed so
  `--frozen-lockfile` installs are actually reproducible in CI rather than re-resolving the
  dependency graph on every run.
- `README.md`'s "Installation" section (goerli contract table, `git clone
  .../suntzu93/threshold-tBTC.git`, `graph auth --product hosted-service`) is trimmed to a
  short pointer at `docs/deployment.md`, which is now the canonical source for the deploy flow.
  The per-network contract address tables in README (Goerli/Mainnet) are dropped in favor of
  `networks.json`, which is already the single source of truth the build patches from.
- `docs/deployment.md` (already written) documents tracks/triggers, the promotion path,
  required one-time repo configuration, and rollback — the human-facing reference these
  workflows implement.

## Testing Decisions

Seam: static validation plus local dry-run of the exact commands each job executes — no live
Studio deploy as part of verification (per interview: acceptable confidence for CI/CD config
given no `GRAPH_DEPLOY_KEY_*` secrets exist yet, and a live test deploy would have a real,
unnecessary side effect on `threshold-tbtc-sepolia`).

- `actionlint` against every workflow file — real GitHub Actions schema/semantics validation,
  not just YAML syntax. Must pass with zero findings, including after `osv-scan.yaml` is added.
- `yaml.safe_load` parse check as a baseline sanity pass.
- Local execution of what each job actually runs: `yarn install --frozen-lockfile`, `yarn
  codegen`, `yarn build-sepolia`, `yarn build-mainnet` — all must succeed cleanly.
- `npx --no-install graph --version` — confirms the binary the deploy steps depend on resolves
  from `node_modules/.bin` without a network fetch, i.e. the same resolution path
  `npx --no-install graph deploy ...` will use in CI.
- `bash -n` against the retry-loop shell logic in both deploy workflows.
- No test framework exists in this repo (no eslint/vitest/Matchstick config) and adding one is
  out of scope here — the compile-success signal above is the correctness gate this spec relies
  on, matching what the repo already has.
- Prior art: none in this repo. The workflow shapes are lifted directly from
  `tlabs-xyz/vba-dashboard`'s `ci-checks.yaml`, `cloudflare-pages-prod.yaml`, and
  `osv-scan.yaml`, adapted for a subgraph's build/deploy commands instead of a Vite app's.

## Out of Scope

- **Per-PR ephemeral Studio deployments.** Studio subgraphs cannot be created dynamically via
  the CLI (they're provisioned once via the Studio web UI); replicating Cloudflare Pages'
  per-PR preview model would require pre-provisioning a fixed pool of scratch subgraph slots,
  which is unnecessary complexity for the value it adds here.
- **Automated GitHub Release creation from tags.** `vba-dashboard` doesn't automate this either
  — releases are cut manually (`gh release create` or the web UI) as a separate act from the
  tag push. Kept manual for parity and simplicity.
- **Semgrep / SAST scanning.** `vba-dashboard` also runs Semgrep; only OSV-Scanner (dependency
  vulnerabilities) was put in scope this round, per the interview. A SAST pass is a reasonable
  follow-up, not bundled here.
- **Matchstick unit tests for the AssemblyScript mappings.** No test framework exists today for
  the mapping logic itself; introducing one is a materially larger, separate effort from wiring
  up deploy automation.
- **Automating `production` environment reviewer configuration.** Requires naming a specific
  human or team, which this spec can't decide. Left as a documented one-time manual step.
- **Creating or rotating the actual Studio deploy key secret values.** Credential handling stays
  a human action (`gh secret set ...`) run directly by whoever holds the key, never passed
  through an agent or committed anywhere.

## Further Notes

- **Implementation status (updated after PR #9):** all workflow files, `docs/deployment.md`,
  and the `README.md` trim are implemented and merged into a PR. The `production` GitHub
  Environment and its required reviewer (`piotr-roslaniec`) were created via `gh api`.
  `GRAPH_DEPLOY_KEY_SEPOLIA` and `GRAPH_DEPLOY_KEY_MAINNET` secrets are set — though
  `GRAPH_DEPLOY_KEY_MAINNET` landed as a repo-level secret rather than the intended
  environment-scoped secret on `production` (functionally fine, since environment-scoped jobs
  fall back to repo secrets of the same name; the intended isolation just isn't in effect yet).
  Follow-up: re-set it with `--env production` and delete the repo-level copy.
- **Alternatives considered:**
  - A single shared deploy key across both Studio subgraphs — not actually available; Studio
    scopes deploy keys per-subgraph, so this was ruled out by the platform, not by preference.
  - Fully automatic mainnet deploy with no approval gate (`vba-dashboard`'s current, simplified
    state after their issue #149) — rejected: a subgraph serving other consumers' indexers
    carries a different risk profile than a static site redeploy, and the interview confirmed a
    manual gate is worth the one extra click per release.
  - Tag-gating sepolia the same as mainnet — rejected in favor of continuous staging, so
    testnet never silently lags behind what merged.
- **Known risk, documented not automated:** `graph build --network <x>` / `graph deploy
  --network <x>` mutate the tracked `subgraph.yaml` in place, not just a build-output copy
  (confirmed by observation during design). Irrelevant inside CI (each job is a fresh, ephemeral
  checkout), but a maintainer building locally across networks should `git checkout --
  subgraph.yaml` between network switches to avoid accidentally committing a network swap.
  Worth a one-line callout in `docs/deployment.md` if not already present.
- **Correction discovered on first real PR run:** `osv-scan.yaml`'s diff-aware PR scan
  (`fail-on-vuln: true`, the reusable workflow's default) failed on the very PR that introduced
  it — 19 packages / 69 known vulnerabilities, entirely inherited transitives of `graph-cli`
  0.61.0 (`axios` 0.21.4, `tar` 6.2.1, `protobufjs` 6.11.6, `uuid` 3.4.0/8.3.2, `request`
  2.88.2, and others). This wasn't a false positive: because `master` had no lockfile at all
  before this PR, the scanner's base-branch diff treats the entire newly-added `yarn.lock` as
  "introduced" by the PR, so 100% of graph-cli's pre-existing dependency debt surfaced as new.
  Several of the available fixes are major-version bumps on packages graph-cli's own runtime
  depends on (IPFS client, protobuf encoding) — forcing yarn resolutions on them without a live
  Studio deploy to catch a regression was judged too risky to do blind as part of a CI/CD PR.
  Resolution: set `fail-on-vuln: false` on both `osv-scan.yaml` jobs, so findings stay visible
  (job log/artifact) without blocking merges. Tracked as follow-up debt: a `graph-cli` upgrade
  (separate, larger, needs its own live-deploy verification) is the real fix, not a resolutions
  hack applied here.
- **Open, unforced risk:** if the first `v*` tag is pushed before the `production` environment
  has a configured reviewer, the approval gate is a silent no-op and the mainnet deploy runs
  unattended. Mitigated: the reviewer was configured (see above) before any tag was pushed.
