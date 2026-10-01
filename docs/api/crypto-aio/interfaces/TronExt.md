[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronExt

# Interface: TronExt

Defined in: [src/adapters/tron/types.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L33)

`bc.ext.tron`: the Tron family extension (spec §5.5).

## Properties

<a id="tron"></a>

### tron

> `readonly` **tron**: `object`

Defined in: [src/adapters/tron/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L34)

#### getResources()

> **getResources**(`address`): `Promise`\<[`TronResources`](TronResources.md)\>

The account's bandwidth and energy, as the full node reports them now.

##### Parameters

###### address

`string`

##### Returns

`Promise`\<[`TronResources`](TronResources.md)\>
