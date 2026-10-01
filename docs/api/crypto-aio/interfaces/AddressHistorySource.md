[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AddressHistorySource

# Interface: AddressHistorySource

Defined in: [src/core/driver/types.ts:269](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L269)

## Methods

<a id="list"></a>

### list()

> **list**(`address`, `options`): `Promise`\<\{ `items`: readonly [`DriverTransaction`](DriverTransaction.md)[]; `next?`: `string`; \}\>

Defined in: [src/core/driver/types.ts:270](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L270)

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
