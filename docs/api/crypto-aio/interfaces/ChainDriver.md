[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainDriver

# Interface: ChainDriver

Defined in: [src/core/driver/types.ts:340](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L340)

The driver port: every method's contract, as the core relies on it. Purpose, retry
class and quorum are the `CallOptions` a driver passes to its `Transport` (defaults:
purpose `read`, retry `safe`, no quorum). A `monitor` or `proof` read only goes to
endpoints that are not lagging.

| Method | Purpose | Retry | Quorum | Returns / throws |
| --- | --- | --- | --- | --- |
| `reader.getBalance`, `getBlock`, `getTransaction` | `read` | `safe` | none | `null` when not found; provider errors propagate |
| `reader.getTokenMetadata` | `read` | `safe` | none (a driver may use a quorum) | A token's own unusable metadata (no contract, a reverting or malformed `decimals`/`symbol`) throws `ValidationError('ASSET_RESOLUTION')`, which the core caches per container (only a non-retryable `ASSET_RESOLUTION` is cached); every other failure, e.g. a transient provider failure (propagated retryable) or any other provider error, is not cached and the next lookup queries again. Stricter than this minimum, the EVM driver reads `decimals()` and `symbol()` under `quorum: 'proof'`: the metadata is cached for the container's life, and one endpoint's wrong `decimals` would mis-scale every amount; endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, which is not cached |
| `reader.getBlockHeight`, `getFinalizedHeight` | `monitor` | `safe` | none | propagate; they feed the stale-view guards and confirmation depths |
| `reader.observe(ref, ordering, from)` | `monitor` | `safe` | none | `{ seen: 'none' }` when not visible; `ordering` and `from` are `undefined` for a transaction the library does not manage |
| `sequence.pending`, `sequence.latest` | `monitor` | `safe` | none | propagate |
| `proofs.*` (`finalizedHead`, `includedFinal`, `slotConsumed`, `expired`, `blockHash`) | `proof` | `safe` | `'proof'` | endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, and the core then decides nothing. Only a definitive negative proof answers "no"; every other RPC error throws retryable `PROVIDER_UNAVAILABLE`, which decides nothing (see below). Only `slotConsumed(…, 'latest')` may be a single `monitor` read: the core records it as observed evidence |
| `broadcaster.broadcast` | `broadcast` | `ambiguous-on-failure` | none (passes `fanout` and `signal` through) | classifies a definitive `RPC_ERROR` into a `BroadcastResult`; rethrows an ambiguous one (`error.ambiguous`) and every other failure unclassified |
| `builder.estimateFee`, `checkFunds`, `build` | `read` | `safe` | none | `ValidationError` / `UnsupportedCapabilityError` for an intent it cannot build |
| `builder.assemble` | no I/O | – | – | `SigningError('SIGNING_FAILED')` when a signature is missing |
| `builder.signaturesFrom` (optional) | no I/O | – | – | `ValidationError('INVALID_INTENT')` when the signed payload is not the prepared transaction |
| `replacement.buildReplacement`, `buildCancel` | `read` | `safe` | none | `ChainError('FEE_TOO_LOW')` below the network's bump; `buildCancel` honours a given `fee` and never substitutes its own |
| `blocks.header` | `monitor` | `safe` | none | `null` while the height is not visible |
| `blocks.transactions` | `monitor` | `safe` | none | retryable `PROVIDER_INCONSISTENT` when the block at `block.height` no longer has `block.hash` |
| `history.list` | `read` (indexer transport when configured) | `safe` | none | propagate |
| `createNativeClient` | no I/O | – | – | a fresh SDK instance on every call, never the pooled one |

Further rules:
- On a proof path (`proofs.*`), only a definitive negative proof may
  answer "no" (`included: false`, a slot not consumed, a `null` block hash). Every other
  RPC error, including state or history not available, pruned data, an index still being
  built ("transaction indexing is in progress"), or an endpoint's non-definitive error,
  must surface as a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides
  nothing: the core looks again later and never takes it for an answer.
- `BlockSource` heights are dense: every height up to the head has one block, and
  `header(h)` is `null` only while `h` is not visible, never for a skipped slot.
- A provider must serve headers at least about 2 × `reorgWindow` below the head. A new
  cursor loads `reorgWindow` blocks below its start, and a rollback refills its window
  below the common ancestor.
- `ScanFilter.addresses`: when non-empty, return at least every transaction with a transfer
  from or to one of them; empty (`[]`) or absent means no filter. `ScanFilter.assets` is a
  hint only: a driver may narrow by it or ignore it, and the core does not filter again.
- `fee.details.requestedFee` is reserved. On replacements the core records the requested
  fee spec there, so a driver never sets or reads it.
- `DriverContext` has no asset resolver and `DriverIntent` carries no decimals. Amounts
  reach drivers in base units only; a driver that needs a token's decimals (Solana's
  `transferChecked`) reads them from the chain itself.

## Properties

<a id="address"></a>

### address

> `readonly` **address**: [`AddressCodec`](AddressCodec.md)

Defined in: [src/core/driver/types.ts:343](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L343)

***

<a id="blocks"></a>

### blocks?

> `readonly` `optional` **blocks?**: [`BlockSource`](BlockSource.md)

Defined in: [src/core/driver/types.ts:350](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L350)

***

<a id="broadcaster"></a>

### broadcaster

> `readonly` **broadcaster**: [`Broadcaster`](Broadcaster.md)

Defined in: [src/core/driver/types.ts:346](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L346)

***

<a id="builder"></a>

### builder

> `readonly` **builder**: [`TxBuilder`](TxBuilder.md)

Defined in: [src/core/driver/types.ts:345](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L345)

***

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: `ReadonlySet`\<[`Capability`](../type-aliases/Capability.md)\>

Defined in: [src/core/driver/types.ts:342](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L342)

***

<a id="ext"></a>

### ext?

> `readonly` `optional` **ext?**: `Readonly`\<`Record`\<`string`, `Readonly`\<`Record`\<`string`, (...`args`) => `Promise`\<`unknown`\>\>\>\>\>

Defined in: [src/core/driver/types.ts:353](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L353)

Two-level, capability-gated family API: `ext.<family>.<method>(...) → Promise`.

***

<a id="history"></a>

### history?

> `readonly` `optional` **history?**: [`AddressHistorySource`](AddressHistorySource.md)

Defined in: [src/core/driver/types.ts:351](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L351)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingKind`](../type-aliases/OrderingKind.md)

Defined in: [src/core/driver/types.ts:341](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L341)

***

<a id="proofs"></a>

### proofs

> `readonly` **proofs**: [`ProofSource`](ProofSource.md)

Defined in: [src/core/driver/types.ts:347](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L347)

***

<a id="reader"></a>

### reader

> `readonly` **reader**: [`ChainReader`](ChainReader.md)

Defined in: [src/core/driver/types.ts:344](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L344)

***

<a id="replacement"></a>

### replacement?

> `readonly` `optional` **replacement?**: [`ReplacementPolicy`](ReplacementPolicy.md)

Defined in: [src/core/driver/types.ts:349](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L349)

***

<a id="sequence"></a>

### sequence?

> `readonly` `optional` **sequence?**: [`SequenceSource`](SequenceSource.md)

Defined in: [src/core/driver/types.ts:348](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L348)

## Methods

<a id="close"></a>

### close()?

> `optional` **close**(): `Promise`\<`void`\>

Defined in: [src/core/driver/types.ts:362](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L362)

#### Returns

`Promise`\<`void`\>

***

<a id="createnativeclient"></a>

### createNativeClient()?

> `optional` **createNativeClient**(): [`DisposableNativeClient`](DisposableNativeClient.md)

Defined in: [src/core/driver/types.ts:361](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L361)

A fresh, caller-owned SDK client for `crypto-aio/native`: a new SDK instance on every
call, never the pooled one.

#### Returns

[`DisposableNativeClient`](DisposableNativeClient.md)

***

<a id="limits"></a>

### limits()?

> `optional` **limits**(`wallet`): [`DriverLimits`](DriverLimits.md)

Defined in: [src/core/driver/types.ts:356](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L356)

#### Parameters

##### wallet

[`WalletOptions`](../type-aliases/WalletOptions.md)

#### Returns

[`DriverLimits`](DriverLimits.md)
