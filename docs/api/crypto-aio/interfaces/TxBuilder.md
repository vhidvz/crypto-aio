[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxBuilder

# Interface: TxBuilder

Defined in: [src/core/driver/types.ts:146](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L146)

## Methods

<a id="assemble"></a>

### assemble()

> **assemble**(`unsigned`, `signatures`): `Promise`\<[`SignedTx`](SignedTx.md)\>

Defined in: [src/core/driver/types.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L158)

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

Defined in: [src/core/driver/types.ts:153](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L153)

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

Defined in: [src/core/driver/types.ts:148](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L148)

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

Defined in: [src/core/driver/types.ts:147](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L147)

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

Defined in: [src/core/driver/types.ts:170](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L170)

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
