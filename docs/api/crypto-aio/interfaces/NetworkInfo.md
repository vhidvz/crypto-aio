[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NetworkInfo

# Interface: NetworkInfo

Defined in: [src/core/model/chain.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L21)

## Properties

<a id="capabilities"></a>

### capabilities?

> `readonly` `optional` **capabilities?**: `object`

Defined in: [src/core/model/chain.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L34)

#### add?

> `readonly` `optional` **add?**: readonly [`Capability`](../type-aliases/Capability.md)[]

#### remove?

> `readonly` `optional` **remove?**: readonly [`Capability`](../type-aliases/Capability.md)[]

***

<a id="defaultconfirmations"></a>

### defaultConfirmations

> `readonly` **defaultConfirmations**: `number`

Defined in: [src/core/model/chain.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L28)

***

<a id="explorer"></a>

### explorer?

> `readonly` `optional` **explorer?**: `object`

Defined in: [src/core/model/chain.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L32)

#### address

> `readonly` **address**: `string`

#### tx

> `readonly` **tx**: `string`

***

<a id="feemodel"></a>

### feeModel

> `readonly` **feeModel**: `string`

Defined in: [src/core/model/chain.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L26)

***

<a id="finality"></a>

### finality

> `readonly` **finality**: [`FinalityPolicy`](../type-aliases/FinalityPolicy.md)

Defined in: [src/core/model/chain.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L27)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/chain.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L22)

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: `string`

Defined in: [src/core/model/chain.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L24)

Expected value of the driver's identity probe (chain id, genesis hash…).

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/model/chain.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L31)

***

<a id="params"></a>

### params?

> `readonly` `optional` **params?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/chain.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L38)

***

<a id="reorgwindow"></a>

### reorgWindow

> `readonly` **reorgWindow**: `number`

Defined in: [src/core/model/chain.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L30)

Recent blocks a scanner retains for rollback detection; independent of finality.

***

<a id="replacement"></a>

### replacement?

> `readonly` `optional` **replacement?**: `object`

Defined in: [src/core/model/chain.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L33)

#### minBumpPercent

> `readonly` **minBumpPercent**: `number`

***

<a id="testnet"></a>

### testnet

> `readonly` **testnet**: `boolean`

Defined in: [src/core/model/chain.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L25)
