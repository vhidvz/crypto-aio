[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FeeEstimateDraft

# Interface: FeeEstimateDraft

Defined in: [src/core/model/fee.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L27)

Driver-level fee estimate (asset refs and base units).

## Properties

<a id="bound"></a>

### bound

> `readonly` **bound**: [`FeeBound`](../type-aliases/FeeBound.md)

Defined in: [src/core/model/fee.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L32)

***

<a id="charges"></a>

### charges

> `readonly` **charges**: readonly [`FeeChargeDraft`](FeeChargeDraft.md)[]

Defined in: [src/core/model/fee.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L31)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/fee.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L36)

The family's fee facts; stored with the Attempt, so plain data only.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `string`

Defined in: [src/core/model/fee.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L29)

The fee model, such as `evm-1559`.

***

<a id="payer"></a>

### payer?

> `readonly` `optional` **payer?**: `string`

Defined in: [src/core/model/fee.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L34)

The paying address, in the driver's canonical form, when the family names it.

***

<a id="speed"></a>

### speed

> `readonly` **speed**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `"custom"`

Defined in: [src/core/model/fee.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/fee.ts#L30)
