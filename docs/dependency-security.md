# Toolchain dependency security

The September 11, 2026 dependency update replaces Graph CLI 0.61.0 with
0.98.1. It removes or patches the affected versions behind 70 of the 71
open Dependabot alerts. The remaining original alert, #45, concerns UUID
APIs that this toolchain does not call. No alerts are dismissed by this change.

These packages run in the Node.js build/deployment tooling. The subgraph's
mapping library remains pinned to `@graphprotocol/graph-ts` 0.31.0. Fixing
these dependencies does not require replacing the deployed subgraph.

## Dependency changes

| Package | Original Dependabot alerts | Remediation |
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
| uuid | 45 | Not applicable to Jayson's argument-free `v4()` calls; see below. |

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

## Remaining scanner matches

The post-update Yarn audit reports two moderate advisories, zero high and
zero critical. Neither advisory's affected operation is reachable through
this project's toolchain callers:

- **UUID 8.3.2 — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
  Dependabot #45.** The defect concerns `v3()`, `v5()`, and `v6()` writing into
  caller-provided buffers. Jayson 4.2.0 imports only `require('uuid').v4`
  and calls it with no arguments to generate JSON-RPC IDs. See
  `jayson/lib/utils.js`, `jayson/lib/generateRequest.js`, and
  `jayson/lib/client/browser/index.js`. The advisory explicitly excludes
  `v4()` from the affected APIs.
- **stream-json 1.9.1 — [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x).**
  The defect concerns Pick/Ignore/Filter/Replace path filters. Jayson imports
  `StreamValues` and `Verifier`, which the advisory does not implicate.
  Moreover, Graph CLI's `dist/command-helpers/jsonrpc.js` constructs only
  HTTP/HTTPS clients; these buffer and JSON-parse responses without invoking
  Jayson's TCP/TLS streaming path. Resolving this package to 3.x would break
  Jayson's CommonJS imports and stream APIs.

Reassess these conclusions if Jayson, the CLI, or the repository begins
using the affected APIs. Scanners remain enabled without advisory
suppressions, so these matches and future findings remain visible.

## Compatibility and validation

Use Node 22 and Yarn 1.22.22, matching CI. `yarn.lock` is the committed
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

The audit exits with status 4 for the two moderate matches described above;
this is not a zero-advisory result. Toolchain tests exercise archive
extraction and the CLI deployment protocol using temporary files, fake
credentials, and local mock endpoints. They do not publish a subgraph or
prove live Studio service compatibility. Production deployment remains a
separate version-tag workflow.
