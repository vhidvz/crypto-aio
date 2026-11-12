[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AddressHistorySource

# Interface: AddressHistorySource

Defined in: [src/core/driver/types.ts:372](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L372)

An address's transactions, newest first, a page at a time (`address-history`).

## Methods

<a id="list"></a>

### list()

> **list**(`address`, `options`): `Promise`\<\{ `items`: readonly [`DriverTransaction`](DriverTransaction.md)[]; `next?`: `string`; \}\>

Defined in: [src/core/driver/types.ts:374](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L374)

A page of at most `limit` transactions after `cursor`, and the cursor of the next.

#### Parameters

##### address

`string`

##### options

###### cursor?

`string`

###### limit

`number`

#### Returns

`Promise`\<\{ `items`: readonly [`DriverTransaction`](DriverTransaction.md)[]; `next?`: `string`; \}\>
