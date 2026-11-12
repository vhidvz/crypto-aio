[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AmountInput

# Type Alias: AmountInput

> **AmountInput** = `bigint` \| `string` \| [`Amount`](../classes/Amount.md)

Defined in: [src/core/model/amount.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L9)

An amount as a caller gives it: a `bigint` in base units, a decimal string in whole
units (`"1.25"`, at most the asset's decimals), or an `Amount` of the same asset. Never a
JavaScript number.
