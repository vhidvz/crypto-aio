[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EvmFeeOverride

# Type Alias: EvmFeeOverride

> **EvmFeeOverride** = \{ `gasLimit?`: `bigint`; `maxFeePerGas`: `bigint`; `maxPriorityFeePerGas`: `bigint`; \} \| \{ `gasLimit?`: `bigint`; `gasPrice`: `bigint`; \}

Defined in: [src/adapters/evm/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L55)

An explicit EVM fee (`TransferIntent.fee`). It must match the network's fee model:
`evm-1559` networks take `{ maxFeePerGas, maxPriorityFeePerGas }`, `evm-legacy` networks
take `{ gasPrice }`. `gasLimit` replaces the node's gas estimate.
