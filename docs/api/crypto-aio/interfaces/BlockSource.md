[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BlockSource

# Interface: BlockSource

Defined in: [src/core/driver/types.ts:361](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L361)

Blocks for the scanner (`block-scan`); heights are dense, as `ChainDriver` says.

## Methods

<a id="header"></a>

### header()

> **header**(`height`): `Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

Defined in: [src/core/driver/types.ts:363](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L363)

The block at `height`, or `null` while it is not visible.

#### Parameters

##### height

`bigint`

#### Returns

`Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

***

<a id="transactions"></a>

### transactions()

> **transactions**(`block`, `filter?`): `Promise`\<readonly [`DriverTransaction`](DriverTransaction.md)[]\>

Defined in: [src/core/driver/types.ts:365](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L365)

The decoded transactions of `block`, narrowed by `filter`.

#### Parameters

##### block

[`DriverBlock`](DriverBlock.md)

##### filter?

[`ScanFilter`](ScanFilter.md)

#### Returns

`Promise`\<readonly [`DriverTransaction`](DriverTransaction.md)[]\>
