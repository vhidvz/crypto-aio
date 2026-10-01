[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptRecord

# Interface: AttemptRecord

Defined in: [src/core/store/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L69)

One concrete signed transaction. Immutable after insertion.

## Properties

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/store/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L78)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/store/types.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L74)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/store/types.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L70)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L73)

***

<a id="purpose"></a>

### purpose

> `readonly` **purpose**: [`AttemptPurpose`](../type-aliases/AttemptPurpose.md)

Defined in: [src/core/store/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L76)

***

<a id="raw"></a>

### raw

> `readonly` **raw**: [`RawTx`](RawTx.md)

Defined in: [src/core/store/types.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L72)

***

<a id="ref"></a>

### ref

> `readonly` **ref**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/store/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L71)

***

<a id="supersedes"></a>

### supersedes?

> `readonly` `optional` **supersedes?**: `string`

Defined in: [src/core/store/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L77)

***

<a id="unsigned"></a>

### unsigned

> `readonly` **unsigned**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L75)
