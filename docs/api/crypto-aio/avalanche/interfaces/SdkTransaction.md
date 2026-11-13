[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkTransaction

# Interface: SdkTransaction

Defined in: [src/adapters/avalanche/sdk.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L90)

An unsigned transaction of any type (`avm.*`, `pvm.*`).

## Extends

- [`SdkSerializable`](SdkSerializable.md)

## Properties

<a id="_type"></a>

### \_type

> `readonly` **\_type**: `string`

Defined in: [src/adapters/avalanche/sdk.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L13)

#### Inherited from

[`SdkSerializable`](SdkSerializable.md).[`_type`](SdkSerializable.md#_type)

***

<a id="basetx"></a>

### baseTx?

> `readonly` `optional` **baseTx?**: [`SdkBaseTx`](SdkBaseTx.md)

Defined in: [src/adapters/avalanche/sdk.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L92)

***

<a id="vm"></a>

### vm

> `readonly` **vm**: `string`

Defined in: [src/adapters/avalanche/sdk.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L91)

## Methods

<a id="getsigindices"></a>

### getSigIndices()

> **getSigIndices**(): `number`[][]

Defined in: [src/adapters/avalanche/sdk.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L93)

#### Returns

`number`[][]
