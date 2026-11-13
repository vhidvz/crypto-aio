[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NetworkInfo

# Interface: NetworkInfo

Defined in: [src/core/model/chain.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L28)

One network of a chain, as built in or as a plugin registers it.

## Properties

<a id="capabilities"></a>

### capabilities?

> `readonly` `optional` **capabilities?**: `object`

Defined in: [src/core/model/chain.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L47)

Capabilities this network adds to or removes from its manifest's.

#### add?

> `readonly` `optional` **add?**: readonly [`Capability`](../type-aliases/Capability.md)[]

#### remove?

> `readonly` `optional` **remove?**: readonly [`Capability`](../type-aliases/Capability.md)[]

***

<a id="defaultconfirmations"></a>

### defaultConfirmations

> `readonly` **defaultConfirmations**: `number`

Defined in: [src/core/model/chain.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L37)

The default target of `waitForConfirmation`; at least 1.

***

<a id="explorer"></a>

### explorer?

> `readonly` `optional` **explorer?**: `object`

Defined in: [src/core/model/chain.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L43)

Explorer URL templates, with `{id}` and `{address}` placeholders.

#### address

> `readonly` **address**: `string`

#### tx

> `readonly` **tx**: `string`

***

<a id="feemodel"></a>

### feeModel

> `readonly` **feeModel**: `string`

Defined in: [src/core/model/chain.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L34)

How the family prices fees, such as `evm-1559`, `evm-legacy` or `utxo`.

***

<a id="finality"></a>

### finality

> `readonly` **finality**: [`FinalityPolicy`](../type-aliases/FinalityPolicy.md)

Defined in: [src/core/model/chain.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L35)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/chain.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L29)

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: `string`

Defined in: [src/core/model/chain.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L31)

Expected value of the driver's identity probe (chain id, genesis hash…).

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/model/chain.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L41)

This network's lag tolerance, when neither `chains.<id>` nor `transport` sets one.

***

<a id="params"></a>

### params?

> `readonly` `optional` **params?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/chain.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L52)

Family-specific network settings; each network page lists its family's.

***

<a id="reorgwindow"></a>

### reorgWindow

> `readonly` **reorgWindow**: `number`

Defined in: [src/core/model/chain.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L39)

Recent blocks a scanner retains for rollback detection; independent of finality.

***

<a id="replacement"></a>

### replacement?

> `readonly` `optional` **replacement?**: `object`

Defined in: [src/core/model/chain.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L45)

The least fee increase, in percent, a node accepts for a replacement.

#### minBumpPercent

> `readonly` **minBumpPercent**: `number`

***

<a id="testnet"></a>

### testnet

> `readonly` **testnet**: `boolean`

Defined in: [src/core/model/chain.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L32)
