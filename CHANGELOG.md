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
- The Tron family, built in: `tron` on mainnet, Shasta and Nile, with tronweb 6 as an optional
  peer dependency; TRX and TRC-20 transfers with memos; the `tron` fee kind (`bandwidth`,
  `energy`, `activation` and `memo` charges, any of which may be 0) with a `{ feeLimit }`
  override for TRC-20 transfers; `expiry` ordering with proven expiry and `rebuild`; finality
  at the solidified block; block scanning; TronGrid address history through an indexer
  provider; the `trongrid` and `public` presets; and USDT by alias.
- The `crypto-aio/tron` entry: `TRON_CAPABILITIES`, `TRON_INDEXER_CAPABILITIES`,
  `TRON_PEER_DEPENDENCIES`, the expiration, energy-margin and memo limits, and the SDK type
  for `native(bc, 'tronweb')`; also `bc.ext.tron.getResources(address)`, a typed
  `ChainRegistry` entry for `tron`, and the root type exports `TronExt`, `TronFeeDetails`,
  `TronFeeOverride`, `TronResources` and `TronExpiryOrdering`.
- `CallOptions.quorumKey`: under a quorum, endpoints must agree only on the part of the
  result that the key returns.
- `CallOptions.exactIntegers`: `Transport.rpc`, `rpcRaw` and `http` can parse JSON integers
  beyond 2^53 − 1 as `bigint`, so amounts are never rounded and a quorum compares them exactly.
- `Blockchain.submitSignatures(operationId, signed)` also takes a whole transaction signed
  elsewhere (a `RawTx`, such as a PSBT) where the chain's driver implements the optional
  `TxBuilder.signaturesFrom` port. Only its signatures are used, each verified against its
  stored request.
- `DriverOutput` and `DriverIntent.outputs[i].variant`: the recipient address's variant (TON's
  bounce flag) reaches drivers and is part of the intent hash. Outputs without a variant hash
  as before.
- `TxStatus.reason` for on-chain failures: a driver may return a short fixed `reason` from
  `observe` and `ProofSource.includedFinal`.
- `WalletHdOptions`, and an `hd` entry in `WalletOptions`: drivers receive the wallet's
  extended public key.

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
- Health probes wait for their endpoint's rate-limit tokens, ahead of requests already
  waiting, and a first-use identity probe goes before the request's own token, so a keyless
  1 request/second endpoint stays healthy. After a fully failed health refresh, the next one
  waits at least until each bucket has refilled the probes' tokens plus one.
- On an endpoint's first use, the `rpc.error` event's `latencyMs` and the endpoint's
  `latencyMs` in `status()` no longer include the identity check.
- A proof quorum (every `quorum: 'proof'` read, whatever its `purpose`, and any quorum read
  for a monitor or proof purpose) is never asked of fewer endpoints than the quorum because
  of height lag, an unknown height, an identity not yet confirmed or an open circuit
  breaker. An endpoint keeps counting until its identity is proven mismatched or three
  health refreshes in a row, at most one per `healthIntervalMs`, fail its identity or height
  probe or find its requests failing (its breaker not closed, or `failureThreshold` failures
  in a row); with an identity probe alone, each refresh re-probes a confirmed identity. An
  endpoint out of the count never answers toward a proof: while its breaker is half-open it
  is tried alongside the others and can only block the proof (its disagreement or refusal
  decides nothing); once it answers, it rejoins the count at the next health refresh, if
  its probes answer; the next proof read triggers that refresh. A proof read waits for a
  trial it sends, up to the call's timeout; a trial whose endpoint has no rate-limit token
  free is skipped for that read, and each concurrent proof read in a half-open window may
  send its own trial. Only a confirmed, in-range endpoint whose breaker lets requests
  through answers; otherwise the read decides nothing (a retryable `PROVIDER_UNAVAILABLE`).
  A `quorum: 'proof'` read keeps health fresh under any purpose. With no probe configured,
  the quorum counts only the usable endpoints, as before, so a chain family sets its
  probes.
- For proof reads and proof quorums, lag is measured against the second-highest known
  height, so one endpoint that over-reports its head never marks honest ones as lagging.
  With two endpoints that excludes neither, so a proof read should be anchored to a block
  height. A single monitor read and `status()` still measure lag against the highest known
  height.
- In a proof quorum, a definitive error decides only when every endpoint of the quorum
  returns an equivalent one: the same error code, HTTP status and JSON-RPC error code, and
  for a JSON-RPC code whose meaning each server defines (-32000 to -32099, and -32603) the
  same message. Against an answer, or a different error, the read decides nothing (a
  retryable `PROVIDER_INCONSISTENT`). While at least two endpoints are in the count, one
  endpoint's revert therefore never fails a token for good. The `provider.inconsistent`
  event is now also emitted when a proof quorum sees a refusal against an answer, or unlike
  refusals.
- A quorum compares answers in a form where an object never equals a `bigint`, so under
  `exactIntegers` an endpoint's `{"$bigint": …}` object no longer agrees with another's
  exact integer.
- These cost liveness. Proofs wait at startup until enough endpoints are confirmed and in
  range, and while an honest endpoint's breaker is open for less than three health
  intervals. An endpoint that stops answering its probes or its requests holds them back for
  about three health intervals; after that it no longer counts, so with two endpoints the
  other decides alone until the first answers a trial again and rejoins at the next health
  refresh, if its probes answer; the next proof read triggers that refresh. With two
  endpoints both must answer, so use three or more for production proofs. Errors worded
  differently decide nothing.
- An observation clears an earlier failure or refusal reason once the transaction succeeds,
  leaves its block or is proven replaced, and whenever a rebroadcast, accepted or
  ambiguous, makes it `pending` again. `TxStatus.reason` is present only with `failed`,
  `refused` or `rejected`.
- The `OperationStore` contract suite now checks that `putObservation` replaces the whole
  observation, and that a field left out or set to `undefined` reads back `undefined`
  (never `null`).
- An Operation whose signed transaction is identical to another Operation's fails with
  `NONCE_CONFLICT` (`details.heldBy`) before anything is sent; a replacement, cancel or
  rebuild in that case is refused and its Operation is unchanged. The testing kit's `expiry`
  fake chain, which signs identical transfers into identical bytes, shows it. Durable stores:
  `findByRef` must be read-your-writes consistent across processes.
- A plugin registered under a name that a different plugin already holds throws
  `CONFIG_INVALID` (it was silently ignored). Registering the same plugin again stays a no-op;
  a plugin whose functions are rebuilt on each call is a different plugin.
- `deriveAddress` on UTXO chains refuses an extended key whose Bitcoin SLIP-0132 version is of
  the other network class with `CONFIG_INVALID`; `deriveXpubChild` takes an optional `network`.
- `deriveXpubChild` refuses a key that is not a string, and a private key named by its
  SLIP-0132 prefix (such as `xprv`), with `CONFIG_INVALID` instead of a `TypeError` or an
  unsupported-prefix error. Its unsupported-format message no longer quotes the key's
  prefix, and "invalid extended public key" no longer carries the parser's error as its
  `cause`.
- An address codec whose `normalize` returns a `variant` holding anything but JSON scalars
  (strings, finite numbers, booleans, `null`) under string keys now fails transfers to that
  address with `INVALID_ADDRESS`. This affects custom chain plugins.
- A wallet whose `xpub` is private, unreadable, or in a format that needs `xpubVersions` (a
  SLIP-0132 `ypub`, `zpub` or `vpub` without them) is now refused with `CONFIG_INVALID`
  when the wallet is resolved, so on every use of that wallet: sends, `walletAddress`,
  `ready()`, `limits()` and the writes on its stored Operations that resolve the wallet (the
  all-rejected verdict, nonce reconciliation and recovery's resend), not only
  `deriveAddress`. The refusal repeats no part of the key. An empty `xpub` counts as none.
  An `xpubPath` that is not a string is refused the same way, at resolution and in
  `deriveAddress`.
- `hd` in `WalletOptions` is reserved: neither a wallet's own `options.hd` nor the
  `options` passed to `Blockchain.addressFromPublicKey` bring an `hd` to a driver.
  `addressFromPublicKey` reads `null` options as none.

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
