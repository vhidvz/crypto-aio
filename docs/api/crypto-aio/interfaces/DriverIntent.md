[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverIntent

# Interface: DriverIntent

Defined in: [src/core/model/intent.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L49)

What drivers receive: canonical strings and base units only.

## Extended by

- [`StoredIntent`](StoredIntent.md)

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/model/intent.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L50)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L54)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/model/intent.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L52)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L53)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`DriverOutput`](DriverOutput.md)[]

Defined in: [src/core/model/intent.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L51)
