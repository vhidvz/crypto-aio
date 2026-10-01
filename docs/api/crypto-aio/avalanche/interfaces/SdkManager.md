[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkManager

# Interface: SdkManager

Defined in: [src/adapters/avalanche/sdk.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L104)

The part of `@avalabs/avalanchejs` this library uses, as the native client types it.

## Methods

<a id="getdefaultcodec"></a>

### getDefaultCodec()

> **getDefaultCodec**(): `unknown`

Defined in: [src/adapters/avalanche/sdk.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L105)

#### Returns

`unknown`

***

<a id="packcodec"></a>

### packCodec()

> **packCodec**(`serializable`): `Uint8Array`

Defined in: [src/adapters/avalanche/sdk.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L108)

#### Parameters

##### serializable

[`SdkSerializable`](SdkSerializable.md)

#### Returns

`Uint8Array`

***

<a id="unpack"></a>

### unpack()

> **unpack**\<`T`\>(`bytes`, `unpacker`): `T`

Defined in: [src/adapters/avalanche/sdk.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L106)

#### Type Parameters

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

Defined in: [src/adapters/avalanche/sdk.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L107)

#### Parameters

##### bytes

`Uint8Array`

#### Returns

[`SdkTransaction`](SdkTransaction.md)
