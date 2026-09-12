# Toolchain dependency security

The September 2026 dependency updates replace Graph CLI 0.61.0 with
0.98.1 and remove or patch the affected versions behind all 71 original
Dependabot alerts. They also patch stream-json alert #73, which appeared
after the CLI upgrade. No alerts or advisories are dismissed or suppressed.

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

Yarn audit reports zero advisories for this lockfile as of September 2026.
Both OSV workflows now use `fail-on-vuln: true`, with no advisory exceptions:
pull requests scan dependency changes, and pushes to master scan the full
lockfile. A future finding fails the scan and requires investigation.

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

The audit exits successfully with no known advisories. Toolchain tests
exercise UUID buffer rejection, all four streaming filters' depth limits,
Jayson's streamed JSON and error handling, archive extraction, and the CLI
deployment protocol. They use temporary files, fake credentials, and local
mock endpoints. They do not publish a subgraph or prove live Studio service
compatibility. Production deployment remains a separate version-tag workflow.
