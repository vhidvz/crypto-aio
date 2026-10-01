[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Blockchain

# Class: Blockchain\<C\>

Defined in: [src/core/blockchain/handle.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L78)

Immutable handle bound to one chain, network, library, provider set and wallet.

## Type Parameters

### C

`C` *extends* [`ChainId`](../type-aliases/ChainId.md) = [`ChainId`](../type-aliases/ChainId.md)

## Accessors

<a id="capabilities"></a>

### capabilities

#### Get Signature

> **get** **capabilities**(): `ReadonlySet`\<[`Capability`](../type-aliases/Capability.md)\>

Defined in: [src/core/blockchain/handle.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L108)

A fresh copy on every read; mutating the result never affects `supports()`.

##### Returns

`ReadonlySet`\<[`Capability`](../type-aliases/Capability.md)\>

***

<a id="chain"></a>

### chain

#### Get Signature

> **get** **chain**(): `C`

Defined in: [src/core/blockchain/handle.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L90)

##### Returns

`C`

***

<a id="config"></a>

### config

#### Get Signature

> **get** **config**(): `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/blockchain/handle.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L103)

Frozen, redacted snapshot of the resolved configuration.

##### Returns

`Readonly`\<`Record`\<`string`, `unknown`\>\>

***

<a id="ext"></a>

### ext

#### Get Signature

> **get** **ext**(): [`ExtOf`](../type-aliases/ExtOf.md)\<`C`\>

Defined in: [src/core/blockchain/handle.ts:651](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L651)

Typed family extensions: `bc.ext.<family>.<method>(...)` (async, loads the adapter on demand).

##### Returns

[`ExtOf`](../type-aliases/ExtOf.md)\<`C`\>

***

<a id="library"></a>

### library

#### Get Signature

> **get** **library**(): [`LibraryOf`](../type-aliases/LibraryOf.md)\<`C`\>

Defined in: [src/core/blockchain/handle.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L98)

##### Returns

[`LibraryOf`](../type-aliases/LibraryOf.md)\<`C`\>

***

<a id="network"></a>

### network

#### Get Signature

> **get** **network**(): [`NetworkOf`](../type-aliases/NetworkOf.md)\<`C`\>

Defined in: [src/core/blockchain/handle.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L94)

##### Returns

[`NetworkOf`](../type-aliases/NetworkOf.md)\<`C`\>

## Methods

<a id="abandon"></a>

### abandon()

> **abandon**(`operationId`): `Promise`\<[`OperationView`](../interfaces/OperationView.md)\>

Defined in: [src/core/blockchain/handle.ts:638](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L638)

Abandons an Operation that has no signed transaction yet and releases its reservation.

#### Parameters

##### operationId

`string`

#### Returns

`Promise`\<[`OperationView`](../interfaces/OperationView.md)\>

***

<a id="addressfrompublickey"></a>

### addressFromPublicKey()

> **addressFromPublicKey**(`publicKey`, `options?`): `Promise`\<[`Address`](Address.md)\>

Defined in: [src/core/blockchain/handle.ts:185](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L185)

The chain's address for `publicKey`. `options.hd` is reserved: the core builds it
from a wallet's `xpub`, so a caller's `hd` is dropped and never reaches the driver.
`null` options (from an untyped caller) are none.

#### Parameters

##### publicKey

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

##### options?

[`WalletOptions`](../type-aliases/WalletOptions.md) = `{}`

#### Returns

`Promise`\<[`Address`](Address.md)\>

***

<a id="broadcast"></a>

### broadcast()

> **broadcast**(`raw`): `Promise`\<[`BroadcastResult`](../type-aliases/BroadcastResult.md)\>

Defined in: [src/core/blockchain/handle.ts:629](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L629)

Broadcasts an externally signed transaction WITHOUT creating an Operation: no idempotency,
persistence or monitoring. Prefer prepareTransfer + submitSignatures for managed flows.

#### Parameters

##### raw

[`RawTx`](../interfaces/RawTx.md)

#### Returns

`Promise`\<[`BroadcastResult`](../type-aliases/BroadcastResult.md)\>

***

<a id="cancel"></a>

### cancel()

> **cancel**(`operationId`, `options?`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:611](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L611)

Tries to cancel with a conflicting Attempt (capability `cancel`); the outcome is
`cancelled` only if the cancel wins at finality, and the original may still win. The
cancel pays the network's minimum bump over the highest earlier cancel, or `options.fee`
(refused below that bump).

Repeating the call while a cancel is pending resends it if its broadcast was never
recorded, and returns it while a node holds it or once it is on chain, so concurrent and
retried calls create one cancel. Only a cancel the node refused or dropped is bumped by
a repeat, one step at a time; when the node's minimum fee is more than one bump away,
pass `options.fee`, which always builds a new cancel while none is on chain.

While a replacement is stored but not yet sent, a cancel is refused with
`INVALID_TRANSITION`: repeat that replacement's fee, or call `rebroadcast`, first.

#### Parameters

##### operationId

`string`

##### options?

###### fee?

[`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="deriveaddress"></a>

### deriveAddress()

> **deriveAddress**(`wallet`, `index`): `Promise`\<[`Address`](Address.md)\>

Defined in: [src/core/blockchain/handle.ts:232](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L232)

Derives a deposit address from the wallet's xpub (capability `hd-public-derivation`).

#### Parameters

##### wallet

`string`

##### index

`number`

#### Returns

`Promise`\<[`Address`](Address.md)\>

***

<a id="estimatefee"></a>

### estimateFee()

> **estimateFee**(`intent`): `Promise`\<[`FeeEstimate`](../interfaces/FeeEstimate.md)\>

Defined in: [src/core/blockchain/handle.ts:295](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L295)

#### Parameters

##### intent

[`TransferIntent`](../interfaces/TransferIntent.md)

#### Returns

`Promise`\<[`FeeEstimate`](../interfaces/FeeEstimate.md)\>

***

<a id="getbalance"></a>

### getBalance()

> **getBalance**(`address`, `asset?`): `Promise`\<[`Balance`](../interfaces/Balance.md)\>

Defined in: [src/core/blockchain/handle.ts:280](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L280)

#### Parameters

##### address

`string`

##### asset?

`string` \| \{ `contract`: `string`; `standard`: `string`; \}

#### Returns

`Promise`\<[`Balance`](../interfaces/Balance.md)\>

***

<a id="getbalances"></a>

### getBalances()

> **getBalances**(`address`, `assets`): `Promise`\<[`Balance`](../interfaces/Balance.md)[]\>

Defined in: [src/core/blockchain/handle.ts:288](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L288)

#### Parameters

##### address

`string`

##### assets

readonly (`string` \| \{ `contract`: `string`; `standard`: `string`; \})[]

#### Returns

`Promise`\<[`Balance`](../interfaces/Balance.md)[]\>

***

<a id="getblock"></a>

### getBlock()

> **getBlock**(`ref`): `Promise`\<[`Block`](../interfaces/Block.md) \| `null`\>

Defined in: [src/core/blockchain/handle.ts:377](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L377)

#### Parameters

##### ref

`string` \| `bigint`

#### Returns

`Promise`\<[`Block`](../interfaces/Block.md) \| `null`\>

***

<a id="getblockheight"></a>

### getBlockHeight()

> **getBlockHeight**(): `Promise`\<`bigint`\>

Defined in: [src/core/blockchain/handle.ts:373](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L373)

#### Returns

`Promise`\<`bigint`\>

***

<a id="getnetworkstatus"></a>

### getNetworkStatus()

> **getNetworkStatus**(): `Promise`\<[`NetworkStatus`](../interfaces/NetworkStatus.md)\>

Defined in: [src/core/blockchain/handle.ts:469](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L469)

#### Returns

`Promise`\<[`NetworkStatus`](../interfaces/NetworkStatus.md)\>

***

<a id="getoperation"></a>

### getOperation()

> **getOperation**(`operationId`): `Promise`\<[`OperationView`](../interfaces/OperationView.md) \| `null`\>

Defined in: [src/core/blockchain/handle.ts:643](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L643)

An Operation of this handle's chain and network (another one is INVALID_INTENT).

#### Parameters

##### operationId

`string`

#### Returns

`Promise`\<[`OperationView`](../interfaces/OperationView.md) \| `null`\>

***

<a id="gettransaction"></a>

### getTransaction()

> **getTransaction**(`id`): `Promise`\<[`Transaction`](../interfaces/Transaction.md) \| `null`\>

Defined in: [src/core/blockchain/handle.ts:314](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L314)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`Transaction`](../interfaces/Transaction.md) \| `null`\>

***

<a id="gettransactionstatus"></a>

### getTransactionStatus()

> **getTransactionStatus**(`id`): `Promise`\<[`TxStatus`](../interfaces/TxStatus.md)\>

Defined in: [src/core/blockchain/handle.ts:326](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L326)

Status of a managed Operation (by id, Attempt ref or tx hash) or of any transaction id.

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`TxStatus`](../interfaces/TxStatus.md)\>

***

<a id="history"></a>

### history()

> **history**(`address`, `options?`): `Promise`\<\{ `items`: readonly [`Transaction`](../interfaces/Transaction.md)[]; `next?`: `string`; \}\>

Defined in: [src/core/blockchain/handle.ts:429](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L429)

Indexer-backed transaction history of an address (capability `address-history`).

#### Parameters

##### address

`string`

##### options?

###### cursor?

`string`

###### limit?

`number`

#### Returns

`Promise`\<\{ `items`: readonly [`Transaction`](../interfaces/Transaction.md)[]; `next?`: `string`; \}\>

***

<a id="limits"></a>

### limits()

> **limits**(): `Promise`\<[`DriverLimits`](../interfaces/DriverLimits.md)\>

Defined in: [src/core/blockchain/handle.ts:163](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L163)

#### Returns

`Promise`\<[`DriverLimits`](../interfaces/DriverLimits.md)\>

***

<a id="normalizeaddress"></a>

### normalizeAddress()

> **normalizeAddress**(`address`): `Promise`\<[`Address`](Address.md)\>

Defined in: [src/core/blockchain/handle.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L178)

#### Parameters

##### address

`string`

#### Returns

`Promise`\<[`Address`](Address.md)\>

***

<a id="preparetransfer"></a>

### prepareTransfer()

> **prepareTransfer**(`intent`, `options?`): `Promise`\<[`PreparedOperation`](../interfaces/PreparedOperation.md)\>

Defined in: [src/core/blockchain/handle.ts:491](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L491)

Builds and persists the unsigned transaction (reserving nonce/inputs) for offline or async signing.

#### Parameters

##### intent

[`TransferIntent`](../interfaces/TransferIntent.md)

##### options?

[`TransferOptions`](../interfaces/TransferOptions.md) = `{}`

#### Returns

`Promise`\<[`PreparedOperation`](../interfaces/PreparedOperation.md)\>

***

<a id="ready"></a>

### ready()

> **ready**(): `Promise`\<`Blockchain`\<`C`\>\>

Defined in: [src/core/blockchain/handle.ts:136](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L136)

Loads the adapter, connects its transport and validates it's actually usable; fails fast
on a missing dependency (`DEPENDENCY_MISSING`), an invalid wallet (surfaced by resolving
it), or a provider that can't serve reads: `PROVIDER_UNAVAILABLE` when no configured
endpoint is usable, `PROVIDER_MISCONFIGURED` (non-retryable) when every endpoint's
identity mismatches the configured network. An endpoint is usable when it's 'healthy',
'lagging' or 'half-open' (the breaker is willing to try it), or 'unknown' while the
transport has no health probes configured at all — nothing could ever have marked it
healthy/lagging in that case, so 'unknown' is simply its steady state.

#### Returns

`Promise`\<`Blockchain`\<`C`\>\>

***

<a id="rebroadcast"></a>

### rebroadcast()

> **rebroadcast**(`operationId`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:567](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L567)

Resends the active Attempt's stored raw transaction (e.g. after topping up a stalled wallet).

#### Parameters

##### operationId

`string`

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="rebuild"></a>

### rebuild()

> **rebuild**(`operationId`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:621](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L621)

Expiry-based chains: re-issues an Operation whose earlier Attempts are provably expired.

#### Parameters

##### operationId

`string`

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="replace"></a>

### replace()

> **replace**(`operationId`, `options`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:587](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L587)

Replaces a pending transfer with a higher-fee, mutually exclusive Attempt (capability
`replace-fee`; a synchronous signer). If the node refuses it, the original stays live
and active, and the node's error is thrown.

Idempotent per fee spec: repeating the call with the same `fee` (the same speed name,
or an equal override) returns the replacement it already made, resending it if its
broadcast was never recorded or it was refused; nothing is signed again, and a refusal
is thrown, never reported as a success. To bump again, pass another spec, such as a
higher explicit override.

While that replacement is stored but not yet sent, another fee spec (or a cancel) is
refused with `INVALID_TRANSITION`: repeat the same spec, or call `rebroadcast`, first.

#### Parameters

##### operationId

`string`

##### options

###### fee

[`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="resolveasset"></a>

### resolveAsset()

> **resolveAsset**(`asset?`): `Promise`\<[`AssetInfo`](../interfaces/AssetInfo.md)\>

Defined in: [src/core/blockchain/handle.ts:275](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L275)

#### Parameters

##### asset?

`string` \| \{ `contract`: `string`; `standard`: `string`; \}

#### Returns

`Promise`\<[`AssetInfo`](../interfaces/AssetInfo.md)\>

***

<a id="scanner"></a>

### scanner()

> **scanner**(`options`): [`Scanner`](../interfaces/Scanner.md)

Defined in: [src/core/blockchain/handle.ts:386](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L386)

Reorg-aware, at-least-once block scanner (capability `block-scan`): `ack()` each event
to commit the cursor before asking for the next. Invalid options throw `CONFIG_INVALID`.

#### Parameters

##### options

[`ScannerOptions`](../interfaces/ScannerOptions.md)

#### Returns

[`Scanner`](../interfaces/Scanner.md)

***

<a id="submitsignatures"></a>

### submitSignatures()

> **submitSignatures**(`operationId`, `signatures`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:518](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L518)

Completes an Operation that awaits signatures, with signature bundles or with the whole
payload signed elsewhere, e.g. a signed PSBT: the driver extracts its signatures
(`TxBuilder.signaturesFrom`), and each is verified against the stored request exactly
like a bundle. `UNSUPPORTED_CAPABILITY` when the chain's driver cannot read one.

#### Parameters

##### operationId

`string`

##### signatures

readonly [`SignatureBundle`](../interfaces/SignatureBundle.md)[] \| [`RawTx`](../interfaces/RawTx.md)

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="supports"></a>

### supports()

> **supports**(`capability`): `boolean`

Defined in: [src/core/blockchain/handle.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L112)

#### Parameters

##### capability

[`Capability`](../type-aliases/Capability.md)

#### Returns

`boolean`

***

<a id="transfer"></a>

### transfer()

> **transfer**(`intent`, `options?`): `Promise`\<[`Submission`](../interfaces/Submission.md)\>

Defined in: [src/core/blockchain/handle.ts:504](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L504)

Idempotent transfer. Throws the mapped chain error when the Operation stalls or fails;
throws an `ambiguous` error (with `context.operationId`) when the broadcast outcome is
unknown. Retry with the same `idempotencyKey` in both cases.

#### Parameters

##### intent

[`TransferIntent`](../interfaces/TransferIntent.md)

##### options?

[`TransferOptions`](../interfaces/TransferOptions.md) = `{}`

#### Returns

`Promise`\<[`Submission`](../interfaces/Submission.md)\>

***

<a id="validateaddress"></a>

### validateAddress()

> **validateAddress**(`address`): `Promise`\<`boolean`\>

Defined in: [src/core/blockchain/handle.ts:174](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L174)

#### Parameters

##### address

`string`

#### Returns

`Promise`\<`boolean`\>

***

<a id="waitforconfirmation"></a>

### waitForConfirmation()

> **waitForConfirmation**(`ref`, `options?`): `Promise`\<[`ConfirmationResult`](../interfaces/ConfirmationResult.md)\>

Defined in: [src/core/blockchain/handle.ts:340](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L340)

Resolves once `confirmations` (default: the handle's) are reached. With
`finality: 'final'`, a managed Operation (by id, Attempt ref or tx hash) resolves on
**proven** finality (finalized data confirmed by quorum proof reads); a transaction the
library does not manage resolves on **observed** finality (one endpoint's view of a
block at or below the finalized height). Rejects with the chain error when the
Operation fails, expires or is replaced (`TX_REVERTED` for an unmanaged transaction
that reverted), with `TIMEOUT` (retryable, state unchanged) when time runs out, and
with the reason of an aborted `signal`.

#### Parameters

##### ref

`string`

##### options?

[`WaitOptions`](../interfaces/WaitOptions.md) = `{}`

#### Returns

`Promise`\<[`ConfirmationResult`](../interfaces/ConfirmationResult.md)\>

***

<a id="walletaddress"></a>

### walletAddress()

> **walletAddress**(`wallet?`): `Promise`\<[`Address`](Address.md)\>

Defined in: [src/core/blockchain/handle.ts:199](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L199)

Address of the handle's own selected wallet, or of another configured `wallet` by name
— resolved fresh against this handle's driver, without switching the handle.
Re-resolved through `resolveSelection` (not `resolveWallet` directly) so a
named wallet gets the same `wallet.chains` enablement check, unknown-signer validation and
signer-scheme compatibility check that the handle's own wallet got at construction.

#### Parameters

##### wallet?

`string`

#### Returns

`Promise`\<[`Address`](Address.md)\>

***

<a id="watch"></a>

### watch()

> **watch**(`ref`, `options?`): `AsyncIterable`\<[`TxStatusEvent`](../interfaces/TxStatusEvent.md)\>

Defined in: [src/core/blockchain/handle.ts:353](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L353)

Yields each status change until the Operation is terminal (or the transaction is final).

#### Parameters

##### ref

`string`

##### options?

###### pollIntervalMs?

`number`

###### signal?

`AbortSignal`

#### Returns

`AsyncIterable`\<[`TxStatusEvent`](../interfaces/TxStatusEvent.md)\>

***

<a id="with"></a>

### with()

> **with**(`overrides`): `Blockchain`\<`C`\>

Defined in: [src/core/blockchain/handle.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L117)

Returns a NEW handle; this handle and operations started from it are unaffected.

#### Parameters

##### overrides

`Partial`\<`Omit`\<[`HandleConfig`](../type-aliases/HandleConfig.md)\<`C`\>, `"chain"`\>\>

#### Returns

`Blockchain`\<`C`\>

***

<a id="create"></a>

### create()

> `static` **create**\<`C`\>(`config`): `Blockchain`\<`C`\>

Defined in: [src/core/blockchain/handle.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L86)

Creates a handle on the default container (see `configure`).

#### Type Parameters

##### C

`C` *extends* [`ChainId`](../type-aliases/ChainId.md)

#### Parameters

##### config

[`HandleConfig`](../type-aliases/HandleConfig.md)\<`C`\>

#### Returns

`Blockchain`\<`C`\>
