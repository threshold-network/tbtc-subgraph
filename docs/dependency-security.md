# Toolchain dependency security

The September 2026 dependency updates replace Graph CLI 0.61.0 with
0.98.1 and remove or patch the affected versions behind all 71 original
Dependabot alerts. They also patch stream-json alert #73, which appeared
after the CLI upgrade. The October update below addresses newly published
glob-library advisories, including one temporary exception for a locally
patched package that has no official fixed release.

These packages run in the Node.js build/deployment tooling. The subgraph's
mapping library remains pinned to `@graphprotocol/graph-ts` 0.31.0. Fixing
these dependencies does not require replacing the deployed subgraph.

## Dependency changes

| Package | Dependabot alerts | Remediation |
| --- | --- | --- |
| axios | 5, 9, 18, 24, 25, 27–36, 46–51, 62, 63 | Gluegun 5.2.2 uses Apisauce 3 and patched Axios 1.x. |
| bn.js | 19 | Remove the old Web3 dependency tree. |
| cross-spawn | 7 | Gluegun 5.2.2 selects 7.0.6. |
| ejs | 1, 6 | Gluegun 5.2.2 selects 3.1.10. |
| elliptic | 13 | Remove the old Web3 dependency tree. |
| form-data | 10, 53 | Remove Request and update Axios's multipart dependencies. |
| immutable | 21, 64, 70 | Resolve to 5.1.9. |
| js-yaml | 11, 56, 57, 66, 71, 72 | Resolve to 4.3.2. |
| parse-duration | 8 | Replace the old IPFS client with Kubo RPC client. |
| protobufjs | 26, 37–44, 54, 55 | Remove the old IPFS/protobuf dependency tree. |
| qs | 12, 68, 69 | Remove Request and its query-string dependencies. |
| request | 2 | Remove the unsupported package. |
| semver | 4 | CLI/Gluegun upgrade removes the affected versions. |
| tar | 14–17, 20, 22, 52, 58–61, 65 | Remove binary-install-raw and its node-tar dependency. |
| tough-cookie | 3 | Remove Request and its cookie dependency. |
| yaml | 23 | Patch CLI's YAML 2.x to 2.9.1; retain patched 1.10.3 for Cosmiconfig. |
| uuid | 45 | Resolve Jayson's dependency to 11.1.1. |
| stream-json | 73 | Resolve Jayson's dependency to 3.6.0 with the compatibility patch below. |

The CLI still pins some vulnerable releases itself. Yarn `resolutions`
select patched releases within their existing major versions for Glob,
Gluegun, Immutable, JS-YAML, Undici, and CLI's YAML dependency. The scoped
YAML resolution preserves Cosmiconfig's 1.x API. These overrides should be
revisited with the next CLI upgrade.

The new CLI's unmaintained `decompress` package is replaced with
`npm:@xhmikosr/decompress@11.1.4`. The original maintainer
[recommends this maintained fork](https://github.com/advisories/GHSA-mp2f-45pm-3cg9).
It preserves the async extraction interface used by the CLI while fixing
archive traversal and unsafe link handling. Glob and Undici are also
patched to avoid introducing known vulnerabilities during the CLI upgrade.

## UUID and stream-json compatibility

Scoped Yarn resolutions select patched releases for every Jayson dependency
path (`**/jayson/uuid` and `**/jayson/stream-json`):

- **UUID 11.1.1** fixes
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
  by rejecting invalid buffer bounds in `v3()`, `v5()`, and `v6()`.
  It retains the CommonJS `v4()` API Jayson uses to generate JSON-RPC IDs.
- **stream-json 3.6.0** includes the fix for
  [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x).
  Pick/Ignore/Filter/Replace reject nesting beyond 1024 by default. The
  repository does not disable that limit.

Jayson 4.2.0 eagerly imports stream-json 1.x APIs even for HTTP deployments.
`patches/jayson+4.2.0.patch` adapts its two imports and two stream constructors
to stream-json 3.x. It uses the published Node stream adapters, preserves
the verifier's byte input mode, and retains JSON streaming, revivers, and
error callbacks. Jayson's HTTP/HTTPS transport code remains unchanged.

`yarn install` applies the patch through `patch-package --error-on-fail`;
installation fails if it cannot apply. `postinstall-postinstall` also
reapplies it after Yarn 1 removes a dependency. Do not use `--ignore-scripts`.
Use Node 22.13.0 or newer: Jayson's CommonJS module loads the new ESM package
through Node's synchronous `require()` support. The root `engines` field
enforces that minimum.

Revisit the resolutions and patch when upgrading Graph CLI or Jayson.
Remove them when the upstream dependency supports patched UUID and
stream-json versions directly. The regression tests resolve packages through
the CLI's actual Jayson dependency, so installing an unused patched copy
cannot satisfy the checks.

Yarn audit reported zero advisories for this lockfile in September 2026.
Both OSV workflows use `fail-on-vuln: true`:
pull requests scan dependency changes, and pushes to master scan the full
lockfile. A future finding fails the scan and requires investigation.

## October 2026 glob-library advisories

The full scan after merging PRs #22–25 found ten package/advisory instances
in dependency versions that already existed before those PRs. The dependencies
run in Node installation/build/deployment tooling; they are not part of the
deployed WASM mappings. Exploitation requires a hostile pattern to reach the
glob libraries. Tooling-only scope is not used as a reason to ignore them.

The lockfile updates `brace-expansion` within each existing major:
`1.1.18 → 1.1.21`, `2.1.4 → 2.1.7`, and `5.0.9 → 5.0.12`. These versions fix
[comma-pattern stack exhaustion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p),
[nested-pattern stack exhaustion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
and [quadratic rewriting](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr).

`braces` 3.0.3 has no official fixed release for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
`patches/braces+3.0.3.patch` backports only the five `lib/` diffs from
[upstream proposed PR #72 at 28d440b5dd449dbf1fe6f3506cf94ecca4d02660](https://github.com/micromatch/braces/pull/72/commits/28d440b5dd449dbf1fe6f3506cf94ecca4d02660).
This is an independently reviewed/tested downstream backport of an open PR,
not a released upstream fix. It excludes unrelated unreleased parser changes.

The patch rejects structural nesting above 100 for both braces and parentheses
before recursive processing. Guards also cover caller-supplied ASTs in
`compile`, `expand`, and `stringify`, including cyclic expansion parent links.
Options can lower the limit but cannot disable or increase the hard cap.
Literal braces inside escaping, quotes, and character classes retain their
existing behavior, as do ordinary ranges, matching, and `escapeInvalid` output.
Excessive nesting produces an explicit validation error; normal patterns are
unchanged. Existing `patch-package --error-on-fail` applies the backport during
installation and fails if it cannot apply.

OSV's version-only scan cannot see this source patch. `osv-scanner.toml` therefore
excepts only this advisory (and its OSV aliases), expiring **2026-11-04**. It does
not ignore the `braces` package or disable either vulnerability gate. OSV's
advisory exception format cannot additionally select a package/version;
`scripts/check-glob-security.test.mjs` verifies the expected 3.0.3 version and
depth guards in **every installed braces copy**, including nested copies.
Those tests are imported by the existing toolchain test suite, so they run in
the mainnet CI build and release deployment gate. Unpatched nested copies fail.
Raw `yarn audit` continues to report the patched advisory; do not describe that
raw result as zero vulnerabilities or dismiss the corresponding GitHub alert.

Before expiry, adopt an official fixed release and remove the patch/exception,
or re-review the backport and record any justified extension. The existing
full OSV scan still fails for all other advisories. Reproduce the local gate with
`osv-scanner scan source --lockfile=./yarn.lock`; use an empty `--config` file to
inspect the underlying unfiltered result.

## Compatibility and validation

Use Node 22 (at least 22.13.0) and Yarn 1.22.22, matching CI. `yarn.lock` is the committed
dependency source; `package-lock.json` is ignored by this repository.

CLI 0.98.1 defaults to Studio, so the removed `--studio` flag is dropped from
both deployment entry points. The existing `Deployed to ` success check
is retained. All 18 entities explicitly declare `immutable: false`, which
preserves their previous default mutability and satisfies the new CLI's
schema validation. No entity fields, mapping handlers, or graph-ts version
change.

```sh
yarn install --frozen-lockfile
yarn codegen
yarn build-mainnet
yarn build-sepolia
node --test scripts/check-toolchain.test.mjs scripts/check-cutover.test.mjs
yarn audit
```

The raw audit reports the locally patched `braces` advisory described above;
the full OSV scan applies its explicit, expiring disposition. Toolchain tests
exercise glob nesting/rewriting limits, UUID buffer rejection, all four streaming filters' depth limits,
Jayson's streamed JSON and error handling, archive extraction, and the CLI
deployment protocol. They use temporary files, fake credentials, and local
mock endpoints. They do not publish a subgraph or prove live Studio service
compatibility. Production deployment remains a separate version-tag workflow.
