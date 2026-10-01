[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FeeEstimate

# Interface: FeeEstimate

Defined in: [src/core/model/fee.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L31)

## Properties

<a id="bound"></a>

### bound

> `readonly` **bound**: [`FeeBound`](../type-aliases/FeeBound.md)

Defined in: [src/core/model/fee.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L35)

***

<a id="charges"></a>

### charges

> `readonly` **charges**: readonly [`FeeCharge`](FeeCharge.md)[]

Defined in: [src/core/model/fee.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L34)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/fee.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L37)

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `string`

Defined in: [src/core/model/fee.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L32)

***

<a id="payer"></a>

### payer?

> `readonly` `optional` **payer?**: [`Address`](../classes/Address.md)

Defined in: [src/core/model/fee.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L36)

***

<a id="speed"></a>

### speed

> `readonly` **speed**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `"custom"`

Defined in: [src/core/model/fee.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L33)
