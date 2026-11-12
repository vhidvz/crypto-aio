[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverFactory

# Interface: DriverFactory

Defined in: [src/core/driver/types.ts:521](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L521)

What a manifest's `load()` returns: makes one driver per pooled selection.

## Methods

<a id="create"></a>

### create()

> **create**(`ctx`): `Promise`\<[`ChainDriver`](ChainDriver.md)\>

Defined in: [src/core/driver/types.ts:522](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L522)

#### Parameters

##### ctx

[`DriverContext`](DriverContext.md)

#### Returns

`Promise`\<[`ChainDriver`](ChainDriver.md)\>
