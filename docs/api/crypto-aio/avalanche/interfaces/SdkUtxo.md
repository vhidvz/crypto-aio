[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkUtxo

# Interface: SdkUtxo

Defined in: [src/adapters/avalanche/sdk.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L63)

The part of `@avalabs/avalanchejs` this library uses, as the native client types it.

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

<a id="assetid"></a>

### assetId

> `readonly` **assetId**: [`SdkId`](SdkId.md)

Defined in: [src/adapters/avalanche/sdk.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L65)

***

<a id="output"></a>

### output

> `readonly` **output**: [`SdkSerializable`](SdkSerializable.md)

Defined in: [src/adapters/avalanche/sdk.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L66)

***

<a id="utxoid"></a>

### utxoId

> `readonly` **utxoId**: [`SdkUtxoId`](SdkUtxoId.md)

Defined in: [src/adapters/avalanche/sdk.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L64)

## Methods

<a id="tobytes"></a>

### toBytes()

> **toBytes**(`codec`): `Uint8Array`

Defined in: [src/adapters/avalanche/sdk.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L68)

Its bytes without the codec version, in `codec`.

#### Parameters

##### codec

`unknown`

#### Returns

`Uint8Array`
