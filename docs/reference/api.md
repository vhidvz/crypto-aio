---
title: API at a glance
parent: Reference
nav_order: 1
description: Every entry point, the container, every handle method, signers, the model, errors, stores, events and the testing kit, each with a link to its guide.
---

# API at a glance

Every public name of crypto-aio, grouped by what you use it for, with a link to the page that
explains it. Types are in the generated TypeDoc reference ([below](#the-full-type-reference));
`test/docs/api-reference.test.ts` checks that this page names every export and every handle
method, so it cannot fall behind the code.

## Entry points

| Import | What it has |
| --- | --- |
| `crypto-aio` | The library: container, handle, model, errors, signers, stores, events, extension types |
| `crypto-aio/evm` | `evmChainPlugin` for your own EVM chains, EVM constants, ethers and web3 client types |
| `crypto-aio/utxo` | Bitcoin constants and the bitcoinjs-lib client type |
| `crypto-aio/tron` | Tron constants and the tronweb client type |
| `crypto-aio/solana` | Solana constants and the `@solana/web3.js` client type |
| `crypto-aio/ton` | TON constants and the `@ton/ton` client type |
| `crypto-aio/avalanche` | Avalanche constants and the `@avalabs/avalanchejs` client type |
| `crypto-aio/testing` | The fake chain, fake time, scripted nodes, crash injection and store contract suites |
| `crypto-aio/native` | `native()`, the escape hatch to a handle's SDK client (outside semver) |

The package is CommonJS with type declarations; `require('crypto-aio')` works as well as
`import`.

## The container: `CryptoAio`

| Member | Does | See |
| --- | --- | --- |
| `new CryptoAio(options?)` | A container: configuration, stores, signers, hooks, plugins, driver pool, event bus | [Configuration](./configuration.md) |
| `aio.blockchain({ chain, … })` | A handle on this container | [The big picture](../tour/architecture.md) |
| `aio.scope(overrides)` | A child container that inherits and overrides configuration, sharing pool and stores | [Core concepts](./concepts.md#container-scope-and-handle) |
| `aio.use(plugin)` | Registers a chain family plugin (root container only; repeatable) | [Write a chain family plugin](../explore/plugins.md) |
| `aio.on(type, handler)`, `aio.onAny(handler)` | Subscribe to [events](#events); each returns an unsubscribe function | [Production architecture](../tour/production.md#watching-it-run) |
| `aio.operations.get(id)`, `.list(filter?)` | Read Operations of this namespace (`filter`: `states`, `chain`, `network`, `limit`) | [The life of a transfer](../tour/transfer.md) |
| `aio.operations.recover({ signal? })` | Startup recovery; returns `{ rebroadcast, checked, skipped, failed, reconciled }` | [Run workers and recover](../build/workers.md) |
| `aio.monitor.start({ workerId?, signal?, batch? })` | Background workers until the signal aborts | [Run workers and recover](../build/workers.md) |
| `aio.monitor.runOnce({ workerId?, batch? })` | One worker pass; returns how many Operations it claimed | [Run workers and recover](../build/workers.md) |
| `aio.close()` | Closes native clients and pooled drivers, stops workers; later calls throw `INVALID_TRANSITION` | [Run workers and recover](../build/workers.md) |
| `aio.namespace` | The namespace that prefixes every store key | [Configuration](./configuration.md) |

`configure(options)` sets up the default container, and `defaultContainer()` returns it;
`Blockchain.create({ chain, … })` makes a handle on it.

## The handle: `Blockchain`

A handle is immutable and bound to one chain, network, library, provider set and wallet.

### Identity and selection

| Member | Returns | Notes |
| --- | --- | --- |
| `chain`, `network`, `library` | The selection | Typed per chain |
| `config` | A frozen, redacted snapshot of the resolved configuration | Secrets show as `[REDACTED]` |
| `capabilities`, `supports(capability)` | The handle's capabilities | [Capabilities](./capabilities.md) |
| `with(overrides)` | A new handle; this one is unchanged | Anything but `chain` |
| `ready()` | `this`, once the SDK is loaded and providers verified | Call at startup |
| `limits()` | `{ maxOutputs }`, the driver's output limit | |
| `ext` | The family's typed extras: `bc.ext.evm`, `bc.ext.tron`, … | [Chains, families and drivers](../tour/families.md) |

### Addresses and assets

| Method | Returns | See |
| --- | --- | --- |
| `validateAddress(text)` | `boolean` | [Wallets, keys and addresses](../learn/foundations/wallets.md) |
| `normalizeAddress(text)` | `Address` (or throws `INVALID_ADDRESS`) | [Core concepts](./concepts.md#wallet-signer-and-address) |
| `walletAddress(wallet?)` | The `Address` of the handle's wallet, or of another configured wallet | |
| `deriveAddress(wallet, index)` | A deposit `Address` from the wallet's `xpub` (`hd-public-derivation`) | |
| `addressFromPublicKey(publicKey, options?)` | The chain's `Address` for a public key | |
| `resolveAsset(asset?)` | `AssetInfo` for `'native'`, an alias such as `'USDC'`, a token ref or an asset id | [Coins, tokens and amounts](../learn/foundations/assets.md) |

### Reading

| Method | Returns | See |
| --- | --- | --- |
| `getBalance(address, asset?)` | `Balance`: `{ address, asset, amount }` | |
| `getBalances(address, assets)` | `Balance[]` | |
| `getBlockHeight()` | The latest height, as `bigint` | |
| `getBlock(heightOrHash)` | `Block` or `null` | |
| `getTransaction(id)` | `Transaction` (status, transfers, fee, decoding) or `null` | [Receive deposits](../build/receive.md) |
| `getNetworkStatus()` | `{ chain, network, height, finalizedHeight, endpoints, indexers }` | [Trust](../learn/engineering/trust.md) |

### Sending

| Method | Returns | See |
| --- | --- | --- |
| `estimateFee(intent)` | `FeeEstimate`: `{ charges, bound, details }`; `feeTotal(estimate, assetId)` sums one asset | [Send a transfer](../build/send.md#fees) |
| `transfer(intent, { idempotencyKey?, signal? })` | `Submission`: the Operation view plus `wait(options)` | [Send a transfer](../build/send.md) |
| `prepareTransfer(intent, options?)` | `PreparedOperation`: the Operation and its unsigned transaction with signing requests | [Cold and asynchronous signing](../build/cold-signing.md) |
| `submitSignatures(operationId, signatures or signed payload)` | `Submission` | [Cold and asynchronous signing](../build/cold-signing.md) |
| `broadcast(raw)` | The node's answer, for bytes signed elsewhere, **without** an Operation: no idempotency or monitoring | Prefer `prepareTransfer` |

A `TransferIntent` is `{ to, amount, asset?, fee?, memo? }`, or `{ outputs: [{ to, amount }, …],
asset?, fee?, memo? }` for several outputs (`batch-transfer`). An amount is a decimal `string`
or base units as a `bigint`; a `number` is refused. `fee` is `'slow'`, `'normal'` (the default),
`'fast'`, or the family's override object.

### Following and fixing an Operation

| Method | Returns | See |
| --- | --- | --- |
| `getOperation(operationId)` | `OperationView` or `null` | [The life of a transfer](../tour/transfer.md) |
| `getTransactionStatus(ref)` | One read of a `TxStatus` | [Wait for confirmation](../build/confirmations.md) |
| `waitForConfirmation(ref, { finality?, confirmations?, timeoutMs?, pollIntervalMs?, signal? })` | `{ status, operation? }` | [Wait for confirmation](../build/confirmations.md) |
| `watch(ref, { pollIntervalMs?, signal? })` | An async iterable of `{ status, operation? }` | [Wait for confirmation](../build/confirmations.md) |
| `rebroadcast(operationId)` | Resends the active Attempt's stored bytes | [Fix a stuck transfer](../build/stalled.md) |
| `replace(operationId, { fee })` | A replacement in the same slot (`replace-fee`) | [Fix a stuck transfer](../build/stalled.md) |
| `cancel(operationId, { fee? })` | A conflicting cancel (`cancel`); wins only if it lands first | [Fix a stuck transfer](../build/stalled.md) |
| `rebuild(operationId)` | Re-issues a proven `expired` Operation (expiry and seqno chains) | [Fix a stuck transfer](../build/stalled.md) |
| `abandon(operationId)` | Ends an Operation before anything was signed | [Fix a stuck transfer](../build/stalled.md) |

A `ref` is an Operation id, an Attempt ref (the transaction hash), or a transaction hash the
monitor has observed; any other id is read as an unmanaged transaction.

### Receiving

| Method | Returns | See |
| --- | --- | --- |
| `scanner({ cursorKey, from?, mode?, filter?, reorgWindow?, pollIntervalMs?, signal? })` | An async iterable `Scanner` of `block` and `rollback` events, each with `ack()` | [Receive deposits](../build/receive.md) |
| `history(address, { cursor?, limit? })` | `{ items: Transaction[], next? }` (`address-history`) | [Receive deposits](../build/receive.md) |

## Signers and secrets

| Name | Does | See |
| --- | --- | --- |
| `localSigner({ id?, secp256k1?, ed25519?, exportable? })` | A signer with keys in memory, from `Secret` keys | [Keys, signers and secrets](../build/keys.md#local-signers) |
| `localSigner.generate({ curves, id?, exportable? })` | New keys: `{ signer, publicKeys }` | |
| `localSigner.fromMnemonic(mnemonic, { id?, passphrase?, curves?, exportable? })` | A BIP39 signer from a `Secret` mnemonic; BIP32 for secp256k1, SLIP-10 for ed25519; paths from the wallet's `keyRef` | |
| `callbackSigner({ id, schemes, getPublicKey, sign, cancelRequest? })` | Any custody system as a signer; `sign` may answer `pending` | [Keys, signers and secrets](../build/keys.md#callback-signers-hsm-kms-mpc-and-remote-custody) |
| `deriveXpubChild(xpub, path, versions?, network?)` | A child public key from an extended public key | |
| `BUILTIN_SCHEMES` | The signature schemes: `secp256k1-ecdsa`, `secp256k1-schnorr`, `ed25519` | |
| `secret(value)`, `reveal(value)`, `isSecret(value)`, `Secret`, `REDACTED` | Wrap a credential so it prints as `[REDACTED]`; read it back explicitly | [Secrets and redaction](../build/keys.md#secrets-and-redaction) |
| `redactUrl(url)`, `redactDeep(value)` | Redact a URL, or every secret-like field of a value, for your own logs | |

## The model

| Name | Is | See |
| --- | --- | --- |
| `Amount` | An exact, non-negative quantity of one asset in base units: `Amount.parse`, `Amount.from`, `Amount.fromBase`, `.base`, `.format()`, `.plus`, `.minus`, `.compare`, `.equals` | [Coins, tokens and amounts](../learn/foundations/assets.md) |
| `Address` | A chain-bound address: `.canonical`, `.display`, `.variant`, `.equals()`, `.format()` | [Wallets, keys and addresses](../learn/foundations/wallets.md) |
| `assetId(chain, network, ref)`, `parseAssetId(id)` | Build and parse asset ids such as `ethereum:mainnet/erc20:0x…` | [Core concepts](./concepts.md#asset-and-amount) |
| `feeTotal(estimate, assetId)` | The total of one asset's charges in a fee estimate | [Send a transfer](../build/send.md#fees) |
| `explorerUrl(network, kind, id)` | A block explorer link from a network's templates | |
| `KNOWN_CAPABILITIES` | The built-in capability names | [Capabilities](./capabilities.md) |
| `Library` | The built-in library names (`ethers`, `web3`, `bitcoinjs-lib`, …) | |
| `TERMINAL_STATES`, `NON_TERMINAL_STATES`, `isTerminal(state)` | The Operation states that end, and those that don't | [Core concepts](./concepts.md#operation-states) |
| `mutuallyExclusive(a, b)` | Whether two orderings conflict (only one can land) | [Nonces, leases and many processes](../tour/ordering.md) |

## Errors

| Name | Is | See |
| --- | --- | --- |
| `CryptoAioError` | The base class: `code`, `category`, `retryable`, `ambiguous`, `context`, `toJSON()` | [Errors](./errors.md) |
| `ConfigError`, `UnsupportedCapabilityError`, `ValidationError`, `ProviderError`, `ChainError`, `SigningError`, `StateError`, `TimeoutError` | One class per category | [Errors](./errors.md#error-classes-and-codes) |
| `isCryptoAioError(value)` | A type guard | |
| `ERROR_CODES` | Every code, with its category and default `retryable` flag | |
| `createError(code, message, options?)` | Builds the right class for a code (for drivers and stores) | |

## Stores

| Name | Is | See |
| --- | --- | --- |
| `createMemoryStores(clock?)` | All four in-memory stores, for tests and single processes | [Write a durable store](../explore/stores.md) |
| `MemoryOperationStore`, `MemoryLockManager`, `MemorySequenceStore`, `MemoryCursorStore` | The in-memory stores, one by one | |
| `DATA_CLASSIFICATION` | Every persisted field's class: `sensitive`, `sensitive-until-broadcast`, `operational` | [Write a durable store](../explore/stores.md#data-classification-for-store-implementers) |
| `CLEARABLE_FIELDS`, `OPERATION_PATCH_KEYS` | The fields an Operation patch may set or clear | |
| `stringifyTagged(value)`, `parseTagged(text)` | JSON that round-trips `bigint` and `Uint8Array` | |

## Events

`aio.on(type, handler)` delivers typed events, each with `type` and `at`. They carry operational
data only: ids, states, codes, heights, timings and sizes.

| Event | Fires when |
| --- | --- |
| `rpc.request`, `rpc.response`, `rpc.error` | The transport sends a request, gets an answer, or fails |
| `provider.health` | An endpoint's state changes: `healthy`, `lagging`, `open`, `disabled` |
| `provider.misconfigured` | An endpoint serves another network |
| `provider.inconsistent` | Endpoints disagree on a quorum read |
| `operation.state` | An Operation moves from one state to another |
| `operation.stalled` | A node refused a signed transfer |
| `attempt.state` | An Attempt's status changes |
| `tx.reorged` | A reorg moved or removed an observed transaction |
| `nonce.allocated`, `nonce.gap` | A nonce or seqno is reserved; a nonce blocks later ones |
| `signer.requested`, `signer.completed` | A signer is asked; it answers (`signed`, `pending` or `error`) |
| `scanner.block`, `scanner.rollback` | A scanner delivers a block; rolls back |
| `recovery.skipped` | `recover()` skipped an Operation that needs you |

`createLogger(namespace, writer)` builds a logger that redacts URLs and secret-like fields before
your writer sees them; `noopLogger` discards everything. The default logger writes through
[`debug`](https://www.npmjs.com/package/debug): `DEBUG=crypto-aio:*`.

## Extension points

For chain family plugins and drivers ([Write a chain family plugin](../explore/plugins.md)),
the package exports the types `Plugin`, `AdapterManifest`, `DriverFactory`, `DriverContext`,
`ChainDriver` and its ports, `ChainInfo`, `NetworkInfo`, `ProviderPreset`, `AssetRegistration`,
`SignatureScheme`, `Transport` and the store ports, and the value `PLACEHOLDER_ORIGIN`, the
origin an SDK sees instead of a real URL. Family entry points add their own:
`evmChainPlugin`, `DEFAULT_MAX_FEE_PER_GAS` and `EVM_CAPABILITIES` (`crypto-aio/evm`);
`MAX_MEMO_BYTES`, `DEFAULT_EXPIRATION_MS`, `MIN_EXPIRATION_MS`, `MAX_EXPIRATION_MS`,
`DEFAULT_MAX_FEE_LIMIT` and `DEFAULT_ENERGY_MARGIN_PERCENT` (`crypto-aio/tron`);
`DEFAULT_MAX_COMPUTE_UNIT_PRICE` (`crypto-aio/solana`); and each family's `…_CAPABILITIES` and
`…_PEER_DEPENDENCIES`.

## The testing kit: `crypto-aio/testing`

| Name | Is | See |
| --- | --- | --- |
| `createFakeEnv(options?)` | A fake chain, a container and a funded handle, on fake time | [Test with the fake chain](../build/testing.md) |
| `FakeChain` | The in-memory chain: `mine`, `reorg`, `configureEndpoint`, `balance`, `nonce`, `sendCount`, … | |
| `fakePlugin()`, `fakeManifest` | The fake family: `fakechain`, `fakeexpiry`, `fakeseqno` | |
| `FakeClock`, `drive(clock, promise)`, `settle` | Time that moves only when you advance it | |
| `FakeFetch`, `rpcResult`, `rpcError`, `hang` | A scripted HTTP server for testing drivers | |
| `FaultyOperationStore`, `CrashError` | A store that "crashes the process" at a chosen write | [Persistence and crash recovery](../learn/engineering/persistence.md) |
| `describeOperationStoreContract`, `describeLockManagerContract`, `describeSequenceStoreContract`, `describeCursorStoreContract` | The store contract suites, for Jest, Vitest or `node:test` | [Write a durable store](../explore/stores.md) |
| `rejectsWithCode`, `SAMPLE_ORDERINGS`, `sampleOperation`, `sampleAttempt` | Helpers for the contract suites | |
| `fakeAddress`, `isFakeAddress`, `fakeTxId`, `fakeDigest`, `signFake`, `encodeEnvelope`, `decodeEnvelope`, `REVERT_ADDRESS` | The fake chain's own formats, for tests that build its data by hand | |

## The full type reference

Every type, with its documentation comments, is generated from the source with TypeDoc. In a
clone of the repository:

```sh
pnpm install
pnpm doc
```

Then open [`docs/api/index.html`](https://htmlpreview.github.io/?https://github.com/vhidvz/crypto-aio/blob/main/docs/api/index.html). It covers every entry point listed above.
