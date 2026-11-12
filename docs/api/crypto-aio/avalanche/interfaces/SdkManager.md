[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkManager

# Interface: SdkManager

Defined in: [src/adapters/avalanche/sdk.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L116)

The part of avalanchejs's `codec Manager` this library uses; it mirrors the SDK, outside semver.

## Methods

<a id="getdefaultcodec"></a>

### getDefaultCodec()

> **getDefaultCodec**(): `unknown`

Defined in: [src/adapters/avalanche/sdk.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L117)

#### Returns

`unknown`

***

<a id="packcodec"></a>

### packCodec()

> **packCodec**(`serializable`): `Uint8Array`

Defined in: [src/adapters/avalanche/sdk.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L120)

#### Parameters

##### serializable

[`SdkSerializable`](SdkSerializable.md)

#### Returns

`Uint8Array`

***

<a id="unpack"></a>

### unpack()

> **unpack**\<`T`\>(`bytes`, `unpacker`): `T`

Defined in: [src/adapters/avalanche/sdk.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L118)

#### Type Parameters

<a id="t"></a>

##### T

`T`

#### Parameters

##### bytes

`Uint8Array`

##### unpacker

[`SdkUnpacker`](SdkUnpacker.md)\<`T`\>

#### Returns

`T`

***

<a id="unpacktransaction"></a>

### unpackTransaction()

> **unpackTransaction**(`bytes`): [`SdkTransaction`](SdkTransaction.md)

Defined in: [src/adapters/avalanche/sdk.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L119)

#### Parameters

##### bytes

`Uint8Array`

#### Returns

[`SdkTransaction`](SdkTransaction.md)
