# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The EVM family, built in: Ethereum (mainnet, Sepolia, Hoodi), BNB Smart Chain, Polygon,
  Avalanche C-Chain, Arbitrum, Optimism and Base, with ethers 6 (the default) or web3 4 as
  optional peer dependencies. A missing SDK fails with `DEPENDENCY_MISSING` and the install
  command.
- Native and ERC-20 transfers with `evm-1559` or `evm-legacy` fees per network, the OP Stack
  L1 data fee as an `l1-data` charge, nonce ordering, and same-nonce replace and cancel
  (except on Arbitrum, which has no mempool).
- Finality from the `finalized` tag, or from confirmations; proofs under the proof quorum,
  including `blockHash`; block scanning of native transfers and ERC-20 `Transfer` logs.
- The `public`, `alchemy`, `infura` and `ankr` provider presets, and USDT and USDC by alias.
- The `crypto-aio/evm` entry: `evmChainPlugin` for EVM chains of your own, registered as
  `evm:<name>`; `EVM_CAPABILITIES` and `EVM_PEER_DEPENDENCIES`; and the SDK types for
  `native(bc, 'ethers')` and `native(bc, 'web3')`.
- `bc.ext.evm.getNonce(address, 'latest' | 'pending')`.
- Typed `ChainRegistry` entries for the seven EVM chains and their networks, and the root
  type exports `EvmExt`, `EvmFeeDetails` and `EvmFeeOverride`.
- `CallOptions.quorumKey`: under a quorum, endpoints must agree only on the part of the
  result that the key returns.

### Changed

- `DEPENDENCY_MISSING` carries the original error as its `cause`, and a missing module that
  is not a peer dependency keeps its own error instead of being reported as a missing SDK.
- A token's own permanent metadata failure (a non-retryable `ASSET_RESOLUTION`) is cached per
  container; any other failure is looked up again.
- Closing a container waits at most 5 seconds for each native client to close.
- `getNetworkStatus()` never reports a finalized height above the head height.
- The proof contract (`ProofSource`): on a proof path, only a definitive negative answer
  says "no". Every other RPC error, such as state not available or an index still being
  built, is a retryable `PROVIDER_UNAVAILABLE` that decides nothing.

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

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/v0.0.2...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/compare/v0.0.2...HEAD
