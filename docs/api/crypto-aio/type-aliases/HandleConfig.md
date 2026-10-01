[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HandleConfig

# Type Alias: HandleConfig\<C\>

> **HandleConfig**\<`C`\> = `Omit`\<[`HandleOptions`](../interfaces/HandleOptions.md), `"chain"` \| `"network"` \| `"library"`\> & `object`

Defined in: [src/core/config/types.ts:129](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L129)

## Type Declaration

### chain

> `readonly` **chain**: `C`

### library?

> `readonly` `optional` **library?**: [`LibraryOf`](LibraryOf.md)\<`C`\>

### network?

> `readonly` `optional` **network?**: [`NetworkOf`](NetworkOf.md)\<`C`\>

## Type Parameters

### C

`C` *extends* [`ChainId`](ChainId.md)
