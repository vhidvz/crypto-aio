[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FeeOverride

# Type Alias: FeeOverride

> **FeeOverride** = `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/fee.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L12)

Family-specific explicit fee parameters (e.g. `{ maxFeePerGas }`, `{ satPerVByte }`). A
plain record through 1.x; each family exports the type of the shape it accepts
(`EvmFeeOverride`, `UtxoFeeOverride`, ...).
