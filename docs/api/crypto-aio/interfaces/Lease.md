[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Lease

# Interface: Lease

Defined in: [src/core/store/types.ts:434](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L434)

A held lock on `key` until `expiresAt` (the store's clock).

## Properties

<a id="expiresat"></a>

### expiresAt

> `readonly` **expiresAt**: `number`

Defined in: [src/core/store/types.ts:439](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L439)

***

<a id="key"></a>

### key

> `readonly` **key**: `string`

Defined in: [src/core/store/types.ts:435](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L435)

***

<a id="owner"></a>

### owner

> `readonly` **owner**: `string`

Defined in: [src/core/store/types.ts:436](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L436)

***

<a id="token"></a>

### token

> `readonly` **token**: `bigint`

Defined in: [src/core/store/types.ts:438](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L438)

Strictly increasing per key across all acquisitions.
