[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LibraryOf

# Type Alias: LibraryOf\<C\>

> **LibraryOf**\<`C`\> = [`FamilyOf`](FamilyOf.md)\<`C`\> *extends* keyof [`FamilyRegistry`](../interfaces/FamilyRegistry.md) ? [`FamilyRegistry`](../interfaces/FamilyRegistry.md)\[[`FamilyOf`](FamilyOf.md)\<`C`\>\] *extends* `object` ? `L` : `string` : `string`

Defined in: [src/core/model/ids.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ids.ts#L30)

The library names of chain `C`'s family.

## Type Parameters

<a id="c"></a>

### C

`C` *extends* [`ChainId`](ChainId.md)
