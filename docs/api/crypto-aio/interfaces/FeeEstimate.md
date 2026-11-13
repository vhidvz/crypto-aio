[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FeeEstimate

# Interface: FeeEstimate

Defined in: [src/core/model/fee.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L46)

What a transfer will pay in fees, from `bc.estimateFee` or a built transaction.

## Properties

<a id="bound"></a>

### bound

> `readonly` **bound**: [`FeeBound`](../type-aliases/FeeBound.md)

Defined in: [src/core/model/fee.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L53)

***

<a id="charges"></a>

### charges

> `readonly` **charges**: readonly [`FeeCharge`](FeeCharge.md)[]

Defined in: [src/core/model/fee.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L52)

A charge per asset and purpose.

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/fee.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L60)

Family-specific facts (`EvmFeeDetails`, `TronFeeDetails`, ...). A plain record through
1.x; each family exports the type of the fields it sets.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `string`

Defined in: [src/core/model/fee.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L48)

The fee model, such as `evm-1559` or `utxo`.

***

<a id="payer"></a>

### payer?

> `readonly` `optional` **payer?**: [`Address`](../classes/Address.md)

Defined in: [src/core/model/fee.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L55)

The address that pays the fee, when the family names it (TON: the sending wallet).

***

<a id="speed"></a>

### speed

> `readonly` **speed**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `"custom"`

Defined in: [src/core/model/fee.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L50)

The speed it was priced at, or `custom` for an explicit override.
