[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SolanaFeeOverride

# Type Alias: SolanaFeeOverride

> **SolanaFeeOverride** = `object`

Defined in: [src/adapters/solana/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L73)

An explicit Solana fee (`TransferIntent.fee`): the compute-unit price in micro-lamports
(at most the handle's `maxComputeUnitPrice`) and, optionally, the compute-unit limit (1 to
1,400,000), which otherwise comes from a simulation of the transaction. A type alias, not
an interface, so a value of this type is assignable to the core's `FeeOverride` record.

## Properties

<a id="computeunitlimit"></a>

### computeUnitLimit?

> `readonly` `optional` **computeUnitLimit?**: `bigint`

Defined in: [src/adapters/solana/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L75)

***

<a id="computeunitprice"></a>

### computeUnitPrice

> `readonly` **computeUnitPrice**: `bigint`

Defined in: [src/adapters/solana/types.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L74)
