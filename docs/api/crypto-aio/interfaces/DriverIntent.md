[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverIntent

# Interface: DriverIntent

Defined in: [src/core/model/intent.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L57)

What drivers receive: canonical strings and base units only.

## Extended by

- [`StoredIntent`](StoredIntent.md)

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/model/intent.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L58)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L62)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/model/intent.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L60)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L61)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`DriverOutput`](DriverOutput.md)[]

Defined in: [src/core/model/intent.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L59)
