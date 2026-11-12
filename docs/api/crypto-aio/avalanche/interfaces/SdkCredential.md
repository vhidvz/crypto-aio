[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkCredential

# Interface: SdkCredential

Defined in: [src/adapters/avalanche/sdk.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L97)

The part of avalanchejs's `Credential` this library uses; it mirrors the SDK, outside semver.

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

Defined in: [src/adapters/avalanche/sdk.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L99)

Each signature as hex (65 bytes: r, s, recovery id).

#### Returns

`string`[]
