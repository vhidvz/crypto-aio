# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Security

- Until this release, the repository tracked a `.env` file containing testnet private keys,
  mnemonics and RPC provider tokens. These credentials remain in the git history and must be
  treated as compromised. The file is no longer tracked, and CI now refuses tracked env files
  and scans for secrets.
- The published npm package was not affected: `files: ["/dist"]` never shipped `.env`.
- Owner actions outside this codebase: rotate the provider tokens, move any funds held by
  those keys, and decide whether to rewrite git history.

### Added

- A chain-agnostic blockchain abstraction layer: the `CryptoAio` container with scopes, the
  immutable `Blockchain` handle, and layered configuration (call > handle > scope > root >
  environment routing > built-ins).
- Operations and Attempts with idempotency keys, crash-safe signing ("never signed twice"),
  observed vs proven evidence, background workers, recovery, replace, cancel and rebuild.
- Signing through `localSigner` or `callbackSigner` (HSM, KMS, MPC), with a `beforeSign`
  policy hook; `Secret` values and redaction keep keys and credentials out of errors, events
  and logs.
- A multi-endpoint HTTP transport with health checks, quorum reads for proofs, and circuit
  breakers; a block scanner with cursors, acknowledgements and reorg rollback.
- A plugin API for chain families, and the `crypto-aio/native` escape hatch.
- The `crypto-aio/testing` kit: a deterministic fake chain family, `FakeFetch`, `FakeClock`,
  `FaultyOperationStore` and the store contract suites.
- Developer guides and a tested tutorial in `docs/guides/`, rendered with the API reference
  by `pnpm doc`.

Only the fake chain family ships in this release. EVM, Bitcoin, Tron, Solana and TON
adapters are planned.

### Removed

- The 0.0.x API: the `CryptoAio` chain getters, `Ethereum`, `Tronix`, `*Account`,
  `*Contract` and `*Transact`. The library was rebuilt; migration notes follow with the
  release.

[0.1.0]: https://github.com/vhidvz/crypto-aio/compare/v0.0.2...HEAD
