[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HandleConfig

# Type Alias: HandleConfig\<C\>

> **HandleConfig**\<`C`\> = `Omit`\<[`HandleOptions`](../interfaces/HandleOptions.md), `"chain"` \| `"network"` \| `"library"`\> & `object`

Defined in: [src/core/config/types.ts:208](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L208)

`HandleOptions` typed for chain `C`: its networks and libraries by name.

## Type Parameters

<a id="c"></a>

### C

`C` *extends* [`ChainId`](ChainId.md)

## Type Declaration

### chain

> `readonly` **chain**: `C`

### library?

> `readonly` `optional` **library?**: [`LibraryOf`](LibraryOf.md)\<`C`\>

### network?

> `readonly` `optional` **network?**: [`NetworkOf`](NetworkOf.md)\<`C`\>
