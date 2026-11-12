[crypto-aio](../../index.md) / [crypto-aio](../index.md) / StoredIntent

# Interface: StoredIntent

Defined in: [src/core/model/intent.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L66)

The intent as an Operation stores it: what the driver got, with the asset's id.

## Extends

- [`DriverIntent`](DriverIntent.md)

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/model/intent.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L58)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`asset`](DriverIntent.md#asset)

***

<a id="assetid"></a>

### assetId

> `readonly` **assetId**: `string`

Defined in: [src/core/model/intent.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L67)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L62)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`fee`](DriverIntent.md#fee)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/model/intent.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L60)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`from`](DriverIntent.md#from)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L61)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`memo`](DriverIntent.md#memo)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`DriverOutput`](DriverOutput.md)[]

Defined in: [src/core/model/intent.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L59)

#### Inherited from

[`DriverIntent`](DriverIntent.md).[`outputs`](DriverIntent.md#outputs)
