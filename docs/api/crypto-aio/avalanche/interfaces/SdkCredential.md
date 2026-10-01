[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkCredential

# Interface: SdkCredential

Defined in: [src/adapters/avalanche/sdk.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L87)

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

## Methods

<a id="getsignatures"></a>

### getSignatures()

> **getSignatures**(): `string`[]

Defined in: [src/adapters/avalanche/sdk.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L89)

Each signature as hex (65 bytes: r, s, recovery id).

#### Returns

`string`[]
