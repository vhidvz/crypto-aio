[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxBuilder

# Interface: TxBuilder

Defined in: [src/core/driver/types.ts:207](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L207)

Builds transactions; the contract table on `ChainDriver` gives each one's call tags.

## Methods

<a id="assemble"></a>

### assemble()

> **assemble**(`unsigned`, `signatures`): `Promise`\<[`SignedTx`](SignedTx.md)\>

Defined in: [src/core/driver/types.ts:233](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L233)

The signed transaction from `unsigned` and its signatures. Its `ref` is the id the
chain will report for it.

`unsigned` may have been stored by an earlier version of the driver: a driver keeps
assembling, replacing and cancelling every `UnsignedTx` and `OrderingData` it ever
stored, since recovery resumes them after an upgrade.

#### Parameters

##### unsigned

[`UnsignedTx`](UnsignedTx.md)

##### signatures

readonly [`SignatureBundle`](SignatureBundle.md)[]

#### Returns

`Promise`\<[`SignedTx`](SignedTx.md)\>

***

<a id="build"></a>

### build()

> **build**(`intent`, `fee`, `ctx`): `Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

Defined in: [src/core/driver/types.ts:220](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L220)

The unsigned transaction. Its `summary` must describe exactly what its payload pays
(asset, outputs, memo): `beforeSign` policies judge the summary, never the bytes.

#### Parameters

##### intent

[`DriverIntent`](DriverIntent.md)

##### fee

[`FeeEstimateDraft`](FeeEstimateDraft.md)

##### ctx

[`BuildContext`](BuildContext.md)

#### Returns

`Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

***

<a id="checkfunds"></a>

### checkFunds()

> **checkFunds**(`intent`, `fee`, `ctx`): `Promise`\<[`FundsCheck`](../type-aliases/FundsCheck.md)\>

Defined in: [src/core/driver/types.ts:211](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L211)

Whether the sender can pay the transfer and `fee`.

#### Parameters

##### intent

[`DriverIntent`](DriverIntent.md)

##### fee

[`FeeEstimateDraft`](FeeEstimateDraft.md)

##### ctx

[`BuildContext`](BuildContext.md)

#### Returns

`Promise`\<[`FundsCheck`](../type-aliases/FundsCheck.md)\>

***

<a id="estimatefee"></a>

### estimateFee()

> **estimateFee**(`intent`, `ctx`): `Promise`\<[`FeeEstimateDraft`](FeeEstimateDraft.md)\>

Defined in: [src/core/driver/types.ts:209](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L209)

The fee the intent's transaction would pay at the intent's speed or override.

#### Parameters

##### intent

[`DriverIntent`](DriverIntent.md)

##### ctx

[`BuildContext`](BuildContext.md)

#### Returns

`Promise`\<[`FeeEstimateDraft`](FeeEstimateDraft.md)\>

***

<a id="signaturesfrom"></a>

### signaturesFrom()?

> `optional` **signaturesFrom**(`unsigned`, `signed`): readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/driver/types.ts:245](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L245)

The signatures a payload signed elsewhere carries for `unsigned`'s requests,
e.g. a PSBT a cold signer returned. No I/O. Throws `ValidationError('INVALID_INTENT')`
when `signed` is not the prepared transaction; one it does not tell apart still fails
the core's check with `SIGNATURE_MISMATCH`. Only signature bytes are taken from it: the
core verifies each one against its stored request, as for any bundle. A request
without a signature in `signed` is left out (a partial set).

#### Parameters

##### unsigned

[`UnsignedTx`](UnsignedTx.md)

##### signed

[`RawTx`](RawTx.md)

#### Returns

readonly [`SignatureBundle`](SignatureBundle.md)[]
