[crypto-aio](../../index.md) / [crypto-aio](../index.md) / StoredIntent

# Interface: StoredIntent

Defined in: [src/core/model/intent.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L57)

What drivers receive: canonical strings and base units only.

## Extends

- [`DriverIntent`](DriverIntent.md)

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/model/intent.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L50)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`asset`](DriverIntent.md#asset)

***

<a id="assetid"></a>

### assetId

> `readonly` **assetId**: `string`

Defined in: [src/core/model/intent.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L58)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L54)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`fee`](DriverIntent.md#fee)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/model/intent.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L52)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`from`](DriverIntent.md#from)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L53)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`memo`](DriverIntent.md#memo)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`DriverOutput`](DriverOutput.md)[]

Defined in: [src/core/model/intent.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L51)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`outputs`](DriverIntent.md#outputs)
