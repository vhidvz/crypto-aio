[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EvmFeeDetails

# Interface: EvmFeeDetails

Defined in: [src/adapters/evm/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L34)

`FeeEstimate.details` of the `evm-1559` and `evm-legacy` fee kinds (wei, gas units).

## Properties

<a id="basefeepergas"></a>

### baseFeePerGas?

> `readonly` `optional` **baseFeePerGas?**: `bigint`

Defined in: [src/adapters/evm/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L41)

`evm-1559` only: the base fee the estimate expects for the next block.

***

<a id="expected"></a>

### expected

> `readonly` **expected**: `bigint`

Defined in: [src/adapters/evm/types.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L47)

The expected total cost in wei; the `network` charge is its upper bound.

***

<a id="gaslimit"></a>

### gasLimit

> `readonly` **gasLimit**: `bigint`

Defined in: [src/adapters/evm/types.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L35)

***

<a id="gasprice"></a>

### gasPrice?

> `readonly` `optional` **gasPrice?**: `bigint`

Defined in: [src/adapters/evm/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L43)

`evm-legacy` only.

***

<a id="l1fee"></a>

### l1Fee?

> `readonly` `optional` **l1Fee?**: `bigint`

Defined in: [src/adapters/evm/types.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L45)

OP Stack networks: the L1 data fee estimate, also charged as `l1-data`.

***

<a id="maxfeepergas"></a>

### maxFeePerGas?

> `readonly` `optional` **maxFeePerGas?**: `bigint`

Defined in: [src/adapters/evm/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L37)

`evm-1559` only.

***

<a id="maxpriorityfeepergas"></a>

### maxPriorityFeePerGas?

> `readonly` `optional` **maxPriorityFeePerGas?**: `bigint`

Defined in: [src/adapters/evm/types.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L39)

`evm-1559` only.
