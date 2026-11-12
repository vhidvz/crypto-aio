[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptRecord

# Interface: AttemptRecord

Defined in: [src/core/store/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L93)

One concrete signed transaction. Immutable after insertion.

## Properties

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/store/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L110)

When the store appended it, by the store's clock.

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/store/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L103)

The fee the transaction was built with.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/store/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L95)

Random and unique across every Operation and namespace.

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L101)

The slot the transaction occupies; a store keeps it whole (`SAMPLE_ORDERINGS`).

***

<a id="purpose"></a>

### purpose

> `readonly` **purpose**: [`AttemptPurpose`](../type-aliases/AttemptPurpose.md)

Defined in: [src/core/store/types.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L106)

***

<a id="raw"></a>

### raw

> `readonly` **raw**: [`RawTx`](RawTx.md)

Defined in: [src/core/store/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L99)

The signed bytes, which recovery sends again exactly as stored.

***

<a id="ref"></a>

### ref

> `readonly` **ref**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/store/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L97)

The transaction's id as the chain will report it.

***

<a id="supersedes"></a>

### supersedes?

> `readonly` `optional` **supersedes?**: `string`

Defined in: [src/core/store/types.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L108)

The Attempt this one replaces or cancels.

***

<a id="unsigned"></a>

### unsigned

> `readonly` **unsigned**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L105)

The unsigned transaction the signatures were made over.
