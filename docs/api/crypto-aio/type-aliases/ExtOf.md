[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ExtOf

# Type Alias: ExtOf\<C\>

> **ExtOf**\<`C`\> = [`FamilyOf`](FamilyOf.md)\<`C`\> *extends* keyof [`FamilyRegistry`](../interfaces/FamilyRegistry.md) ? [`FamilyRegistry`](../interfaces/FamilyRegistry.md)\[[`FamilyOf`](FamilyOf.md)\<`C`\>\] *extends* `object` ? `E` : `unknown` : `unknown`

Defined in: [src/core/model/ids.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ids.ts#L37)

The `bc.ext` API type of chain `C`'s family.

## Type Parameters

<a id="c"></a>

### C

`C` *extends* [`ChainId`](ChainId.md)
