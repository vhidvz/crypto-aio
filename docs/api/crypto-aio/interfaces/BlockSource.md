[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BlockSource

# Interface: BlockSource

Defined in: [src/core/driver/types.ts:261](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L261)

## Methods

<a id="header"></a>

### header()

> **header**(`height`): `Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

Defined in: [src/core/driver/types.ts:262](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L262)

#### Parameters

##### height

`bigint`

#### Returns

`Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

***

<a id="transactions"></a>

### transactions()

> **transactions**(`block`, `filter?`): `Promise`\<readonly [`DriverTransaction`](DriverTransaction.md)[]\>

Defined in: [src/core/driver/types.ts:263](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L263)

#### Parameters

##### block

[`DriverBlock`](DriverBlock.md)

##### filter?

[`ScanFilter`](ScanFilter.md)

#### Returns

`Promise`\<readonly [`DriverTransaction`](DriverTransaction.md)[]\>
