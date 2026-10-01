[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FeeEstimateDraft

# Interface: FeeEstimateDraft

Defined in: [src/core/model/fee.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L17)

Driver-level fee estimate (asset refs and base units).

## Properties

<a id="bound"></a>

### bound

> `readonly` **bound**: [`FeeBound`](../type-aliases/FeeBound.md)

Defined in: [src/core/model/fee.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L21)

***

<a id="charges"></a>

### charges

> `readonly` **charges**: readonly [`FeeChargeDraft`](FeeChargeDraft.md)[]

Defined in: [src/core/model/fee.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L20)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/fee.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L23)

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `string`

Defined in: [src/core/model/fee.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L18)

***

<a id="payer"></a>

### payer?

> `readonly` `optional` **payer?**: `string`

Defined in: [src/core/model/fee.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L22)

***

<a id="speed"></a>

### speed

> `readonly` **speed**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `"custom"`

Defined in: [src/core/model/fee.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L19)
