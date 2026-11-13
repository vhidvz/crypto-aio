[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SigningContext

# Interface: SigningContext

Defined in: [src/core/signing/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L62)

Context handed to signers and policy hooks. Never contains secrets or SDK objects.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/signing/types.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L65)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/signing/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L75)

The fee the transaction pays.

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/signing/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L64)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/signing/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L66)

***

<a id="operationid"></a>

### operationId

> `readonly` **operationId**: `string`

Defined in: [src/core/signing/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L63)

***

<a id="purpose"></a>

### purpose

> `readonly` **purpose**: [`SigningPurpose`](../type-aliases/SigningPurpose.md)

Defined in: [src/core/signing/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L71)

***

<a id="summary"></a>

### summary

> `readonly` **summary**: [`IntentSummary`](IntentSummary.md)

Defined in: [src/core/signing/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L73)

What the transaction pays, as the driver describes its payload.

***

<a id="tier"></a>

### tier?

> `readonly` `optional` **tier?**: `string`

Defined in: [src/core/signing/types.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L70)

The wallet's `tier`, when set.

***

<a id="unsignedhash"></a>

### unsignedHash

> `readonly` **unsignedHash**: `string`

Defined in: [src/core/signing/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L77)

A hash of the unsigned payload, the same for every request of one transaction.

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: `string`

Defined in: [src/core/signing/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L68)

The wallet's name.
