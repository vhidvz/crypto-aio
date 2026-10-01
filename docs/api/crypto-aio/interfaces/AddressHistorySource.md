[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AddressHistorySource

# Interface: AddressHistorySource

Defined in: [src/core/driver/types.ts:274](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L274)

## Methods

<a id="list"></a>

### list()

> **list**(`address`, `options`): `Promise`\<\{ `items`: readonly [`DriverTransaction`](DriverTransaction.md)[]; `next?`: `string`; \}\>

Defined in: [src/core/driver/types.ts:275](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L275)

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
