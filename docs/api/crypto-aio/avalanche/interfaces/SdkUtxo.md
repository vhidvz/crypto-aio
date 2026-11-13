[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkUtxo

# Interface: SdkUtxo

Defined in: [src/adapters/avalanche/sdk.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L72)

The part of avalanchejs's `Utxo` this library uses; it mirrors the SDK, outside semver.

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

Defined in: [src/adapters/avalanche/sdk.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L74)

***

<a id="output"></a>

### output

> `readonly` **output**: [`SdkSerializable`](SdkSerializable.md)

Defined in: [src/adapters/avalanche/sdk.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L75)

***

<a id="utxoid"></a>

### utxoId

> `readonly` **utxoId**: [`SdkUtxoId`](SdkUtxoId.md)

Defined in: [src/adapters/avalanche/sdk.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L73)

## Methods

<a id="tobytes"></a>

### toBytes()

> **toBytes**(`codec`): `Uint8Array`

Defined in: [src/adapters/avalanche/sdk.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L77)

Its bytes without the codec version, in `codec`.

#### Parameters

##### codec

`unknown`

#### Returns

`Uint8Array`
