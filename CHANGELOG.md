# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

crypto-aio 0.1.0 is the first release of the blockchain abstraction layer: one API over EVM
chains, Bitcoin, Tron, Solana and TON, with an SDK-free core, optional SDK peers and a
deterministic testing kit. It replaces the 0.0.x API entirely; see "Migrating from 0.0.x"
below.

### Security

- Until this release, the repository tracked a `.env` file containing testnet private keys,
  mnemonics and RPC provider tokens. These credentials remain in the git history and must be
  treated as compromised. The file is no longer tracked, and CI now refuses tracked env files
  and scans for secrets.
- The published npm package was not affected: `files: ["/dist"]` never shipped `.env`. The
  0.0.1, 0.0.2 and 0.0.3 tarballs on the registry were checked: each holds only `dist/`,
  `package.json`, `README.md` and `LICENSE`.
- Owner actions outside this codebase: rotate the provider tokens, move any funds held by
  those keys, and decide whether to rewrite git history.
- An API key that a provider echoes back is removed from every error message, `details`
  field, `cause` and event, in any letter case, from a URL path segment, a query value, a
  header value or the token after an auth scheme, not only as the whole URL or header
  value. Parts of fewer than 8 characters are removed only as part of the whole URL or
  header value.
- An error never repeats a name the caller typed that the library does not know (a chain,
  network, library, provider or preset, wallet, signer, signature scheme, asset alias,
  option key or capability): it lists the accepted names instead, so a secret pasted into
  the wrong field never reaches a message. A malformed asset id, an invalid namespace and a
  `native()` library name are no longer quoted either.

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
- The UTXO family, built in: Bitcoin (mainnet, testnet, testnet4, signet, regtest) with
  bitcoinjs-lib 7 as an optional peer dependency, over an Esplora indexer (`mempool`,
  `blockstream` and `public` presets).
- p2wpkh, p2sh-p2wpkh, p2pkh and p2tr wallets; PSBT signing payloads with one request per
  input, and signed PSBTs through `submitSignatures`; batch outputs; `{ satPerVByte }` fee
  overrides and an absurd-fee guard; coin selection (`accumulative`, `all`); BIP125 replace
  and cancel; 6-confirmation finality under the proof quorum; block scanning and address
  history; `bc.ext.utxo.listUnspent` and `bc.ext.utxo.coinSelection`.
- The `crypto-aio/utxo` entry: `UTXO_CAPABILITIES`, `UTXO_PEER_DEPENDENCIES`, the SDK-free
  `Utxo*` types (also exported from `crypto-aio`, with the typed `bitcoin` `ChainRegistry`
  entry) and the type of `native(bc, 'bitcoinjs-lib')`.
- `wallet.utxo.allowExternalChangeAddress`: without it, a `changeAddress` that the wallet's
  key or `xpub` does not derive is refused with `CONFIG_INVALID` (an addition to the spec's
  `utxo` wallet options).
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
- The Tron handle option `maxFeeLimit` (sun, a bigint; default 100 TRX, exported as
  `DEFAULT_MAX_FEE_LIMIT`): a TRC-20 transfer's fee limit is at most min(the estimate plus
  its margin, the network's maximum, `maxFeeLimit`), and a transfer whose simulated energy
  needs more is refused with `INVALID_INTENT` before signing. The node reports its maximum,
  the energy price and the simulated energy, so this is the one bound no endpoint can raise.
- The Solana family, built in: `solana` on mainnet, devnet and testnet, with
  `@solana/web3.js` 1.99 as an optional peer dependency. It needs Node.js 22.12 or later: on
  Node 22.0 to 22.11, loading the SDK fails with Node's own `ERR_REQUIRE_ESM`.
- SOL and classic SPL token transfers (`transferChecked`) with memos, one output per
  transfer. A missing associated token account of the recipient is created, with its rent as
  a separate `rent` charge. Transfers that could strand funds (to a program, a program-owned
  account or a token account), frozen token accounts, and accounts left below the
  rent-exempt minimum are refused before signing. Token-2022 mints throw
  `UNSUPPORTED_CAPABILITY`.
- The `solana` fee kind: the signature fee plus a priority fee priced from recent
  prioritization fees, with a `{ computeUnitPrice, computeUnitLimit? }` override. `expiry`
  ordering on the blockhash's last valid block height, with expiry proven from the
  blockhash's own block and every block of its window, and `rebuild`; finality at the
  `finalized` commitment, with quorum proofs.
- Block scanning over dense block heights, address history from `getSignaturesForAddress`
  without an indexer, the `public`, `alchemy`, `infura` and `ankr` presets, USDC and USDT by
  alias, and `bc.ext.solana.getTokenAccounts(owner, mint?)`.
- The `crypto-aio/solana` entry: `SOLANA_CAPABILITIES`, `SOLANA_PEER_DEPENDENCIES` and the
  SDK type for `native(bc, '@solana/web3.js')` (a `Connection`); also a typed
  `ChainRegistry` entry for `solana`, and the root type exports `SolanaExpiryOrdering`,
  `SolanaExt`, `SolanaFeeDetails`, `SolanaFeeOverride` and `SolanaTokenAccount`.
- The Solana handle option `maxComputeUnitPrice` (`chains.solana.options`): the highest
  compute-unit price a transfer signs, 10,000,000 micro-lamports per compute unit by default
  (`DEFAULT_MAX_COMPUTE_UNIT_PRICE`, exported from `crypto-aio/solana`), so no endpoint can
  raise a transfer's priority fee above 0.014 SOL by default. Speeds are clamped below it,
  an override above it is refused before signing, and any other option key is
  `CONFIG_INVALID`.
- The TON family, built in: `ton` on mainnet and testnet, with `@ton/ton` 16, `@ton/core`
  0.63 and `@ton/crypto` 3 as optional peer dependencies, over toncenter's API v2 (the
  `provider`) and its API v3 (the `indexer`, which TON requires); the `toncenter` (keyed)
  and `public` (keyless) presets. The native coin is Gram (`GRAM`, formerly Toncoin), and
  `TON` is an alias for it; USDT by alias on mainnet.
- v4r2 and v5r1 wallets set by `wallets.<name>.ton`; Gram and jetton transfers with text
  memos, one output per transfer (TON batches are not supported yet: a partly delivered
  batch has no safe single verdict); bounce decided by the recipient address's form; the
  `ton` fee kind with an `{ attached }` override for jettons and a ceiling on a node's
  estimate; seqno ordering with a 60-second message lifetime, proven expiry and `rebuild`;
  Attempts identified by their message hash and resolved to transaction hashes; finality on
  masterchain inclusion plus a completed message trace; address history through the
  indexer (no block scan: TON is sharded); `bc.ext.ton.getSeqno` and
  `bc.ext.ton.jettonWallet`.
- The `crypto-aio/ton` entry: `TON_CAPABILITIES`, `TON_INDEXER_CAPABILITIES`,
  `TON_PEER_DEPENDENCIES`, and the SDK type for `native(bc, '@ton/ton')` (a `TonClient`);
  also a typed `ChainRegistry` entry for `ton`, and the root type exports `TonExt`,
  `TonFeeDetails`, `TonFeeOverride`, `TonWalletIdentity` and `TonWalletVersion`.
- TON resends are guarded: before the TON driver sends stored bytes again (a same-key retry,
  a dropped rebroadcast, `rebroadcast`, `recover()` or a bare `broadcast`), it walks the
  wallet's authenticated chain, so a message that already ran is never sent into a wallet
  reset, and it withholds the bytes (a retryable, ambiguous `PROVIDER_UNAVAILABLE`) while it
  cannot decide.
- `TonSeqnoOrdering`, an Attempt's TON ordering with its build's chain time (`validFrom`),
  exported from the root entry and from `crypto-aio/ton`, for store authors.
- The TON driver's `maxNetworkFee` option (`{ basechain?, masterchain? }`, nanograms), in
  `chains.ton.options` or a handle's `options`; any other TON option key is refused with
  `CONFIG_INVALID`.
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
- The EVM handle option `maxFeePerGas` (wei per gas, a bigint; 1,000 gwei by default,
  exported as `DEFAULT_MAX_FEE_PER_GAS` from `crypto-aio/evm`; a network may set
  `params.maxFeePerGas`): no EVM transaction signs a higher price per gas. A node's
  suggestion is clamped to it, and an explicit fee, or a cancel's least bump, above it fails
  with `INVALID_INTENT` before signing (`details.required`, `details.maxFeePerGas`); the
  build checks it again. Every family now bounds a node's fee by an operator setting.
- `transport.maxResponseBytes` (64 MiB by default): a longer answer is cancelled and fails
  as a retryable `PROVIDER_UNAVAILABLE`, so one endpoint cannot exhaust the process's memory.
- `SAMPLE_ORDERINGS` in `crypto-aio/testing`: one Attempt ordering of each built-in family,
  as the operation-store contract suite checks them.

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
- A REST error's message names the route template, as in
  `GET /address/:address/txs refused (HTTP 400)`, no longer the request path with its
  address or transaction id; without a route, only the method.
- Refusals of unknown names read `unknown <what>; the accepted names are 'a' and 'b'`; the
  TON, Solana, Tron, UTXO and EVM option refusals and the core's selection errors use this
  one form.
- The EVM driver reads its handle options: any key but `maxFeePerGas` fails with
  `CONFIG_INVALID` (other keys were ignored).
- The `OperationStore` contract suite checks that an Attempt's `ordering`, its
  `unsigned.ordering` and the Operation's `reservation` read back whole, every property
  with its value and type, for one ordering of each built-in family, after the append and
  after a later write. A store that drops, retypes or changes a property fails it.
- A health check that an endpoint rate-limits (HTTP 429), or that would come before the
  `Retry-After` of an earlier 429, keeps the endpoint's last good height and identity and is
  no health miss; a rate-limited identity check retries after the endpoint's `Retry-After`
  instead of 15 seconds.
- The height high-water mark that a view must stay within `maxLagBlocks` of falls back to
  the verified best height after three health refreshes in a row in which no verified
  endpoint comes that close to it, so one endpoint that once reported a far-future head no
  longer leaves every view stale until restart.
- The root container's `close()` also stops every `monitor.start()` loop, and a running
  `runOnce()` or `operations.recover()` at its next check; starting one on a closed
  container throws `INVALID_TRANSITION`.
- The guides no longer promise `proven` evidence for deposits: every family's deposit reads
  (`scanner`, `history`, `getTransaction`) are `observed`, and the new "Crediting deposits"
  section says how to credit them, with a second read through an independent provider.
- The package also ships `CHANGELOG.md`.

### Fixed

- EVM: a node's rejection of a broadcast ("invalid sender", "invalid chain id", "rlp: …",
  "tip above fee cap") ends an Operation only when the library's own reading of the signed
  bytes confirms it; otherwise it is a refusal (`TX_REFUSED`), and the Operation stalls
  instead of failing, so a lying endpoint that relays the bytes later can no longer make a
  retry pay twice. The UTXO, Tron, Solana and TON drivers already worked this way.
- A network, wallet or signer route named like an `Object.prototype` member (`toString`,
  `constructor`) is an unknown name, never an inherited value.

### Removed

- The 0.0.x API: the `CryptoAio` chain getters, `Ethereum`, `Tronix`, `*Account`,
  `*Contract` and `*Transact`. The library was rebuilt; see "Migrating from 0.0.x" below.
- The 0.0.x documentation site and coverage report under `docs/`. The API reference is
  built with `pnpm doc` into `docs/api/`, and coverage runs in CI.

### Migrating from 0.0.x

The 0.0.x API had no stored transfers, no proofs and few working write paths, so there is
no mechanical upgrade; the new API maps onto the old ideas as follows.

- `new CryptoAio()` with `caio.eth` (`Ethereum`) and the `Tronix` class becomes a container
  and one handle per chain: `new CryptoAio({ providers, signers, wallets, chains })` and
  `aio.blockchain({ chain: 'ethereum' })`, or `configure(…)` and
  `Blockchain.create({ chain: 'tron' })`. Install the SDK of each chain you use (`ethers` or
  `web3`, `tronweb`, …); they are optional peer dependencies.
- `EthereumOptions.lib` (`'web3' | 'ethers'`) becomes the handle's `library`; a `client`
  you built yourself becomes a provider (`{ endpoints: [{ name, url }] }` or a preset with
  an `apiKey`), and the SDK client is reachable only through `crypto-aio/native`.
- `caio.eth.account.getBalance(address)` becomes `bc.getBalance(address, asset?)`, which
  returns an exact `Amount`; `caio.eth.getGasPrice()` becomes `bc.estimateFee(intent)`.
- `caio.eth.createAccount()` and `account.create()`, which emitted private keys through the
  event emitter, are gone: keys exist only inside signers. Use
  `localSigner.generate({ curves: ['secp256k1'] })` for its public keys and
  `bc.addressFromPublicKey(publicKey)`, or import a key with
  `localSigner({ secp256k1: secret(hex) })`.
- `transact.transfer` and `contract.estimateGas` become
  `bc.transfer({ to, amount, asset? }, { idempotencyKey })`, with ERC-20 and TRC-20 tokens
  as an `asset` (an alias such as `'USDT'`, or `{ standard: 'erc20', contract }`) and
  offline signing through `prepareTransfer` and `submitSignatures`.
- The `CRYPTO_AIO_[<ENV>_]<ETH|TRX>_<URL|ADDRESS|PRIVATE|PHRASES|CONTRACT|ABI>` variables
  are gone. The environment now carries routing only,
  `CRYPTO_AIO_[<PROFILE>_]<CHAIN>_{NETWORK|LIBRARY|PROVIDER|RPC_URL|INDEXER_URL}` with
  `CRYPTO_AIO_ENV` naming the profile, and never a key, a mnemonic or an address.
- The `emitter` option becomes typed events (`aio.on(type, handler)`) that carry ids,
  states, codes and timings only; `debug` logging stays (`DEBUG=crypto-aio:*`), or pass
  `createLogger(namespace, writer)`.

### Notes for builds of `main` before 0.1.0

Code built from `main` during 0.1 development saw these changes before the release:

- `Transfer` is `ResolvedTransfer | UnresolvedTransfer`: a transfer whose asset cannot be
  resolved arrives with `unresolved: { asset, amount, code }` and its transaction
  `decoding: 'partial'`.
- `TERMINAL_STATES` is a frozen array, not a `Set`, and every exported table is
  deep-frozen. `Scanner` is exported as a type only (get one from `bc.scanner()`), and
  `ScanEventBody` is exported.
- `createNativeClient` returns `{ client, close? }` (`DisposableNativeClient`); after the
  root's `close()`, handle work and `native()` fail with `INVALID_TRANSITION`.
- `Transport` gained the `maxLagBlocks` accessor and `hasProbes()`; `ProofSource` gained
  `blockHash(height, level)`; `HttpRequest` gained `route`; `chains.<id>.maxLagBlocks` and
  `lifecycle.signTimeoutMs` (120 s) are new.
- The `STATE_UNRECORDED` error code (category `state`, retryable) reports a step that may
  have happened but was not recorded, with the original code in `details.causeCode`; an
  ambiguous error keeps its own code and retryability and adds `ambiguous: true` and the
  `operationId`.
- A pending signing result is stored as `signerTickets` (one per signer); `cancel` and
  `buildCancel` take an optional `fee`.
- The testing kit gained `restart({ killPrevious })`, `forkAbove` and `fake_getBlockHash`.

### For store implementers

The four contract suites in `crypto-aio/testing` define what a durable store must do; run
them against yours. Beyond the suites, which test one store instance:

- `findByRef` must be read-your-writes consistent across every process that shares the
  store, and `appendAttempt` must complete within `lifecycle.leaseMs` (see "Changed").
- Keep each Attempt's `ordering` whole, and store a patch key set to `undefined` as absent,
  never as `null` (the suites check both).
- `DATA_CLASSIFICATION` names each field's class for encryption and retention.

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/compare/v0.0.2...v0.1.0
