[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkTransferableOutput

# Interface: SdkTransferableOutput

Defined in: [src/adapters/avalanche/sdk.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L51)

The part of avalanchejs's `TransferableOutput` this library uses; it mirrors the SDK, outside semver.

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

Defined in: [src/adapters/avalanche/sdk.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L52)

***

<a id="output"></a>

### output

> `readonly` **output**: [`SdkSerializable`](SdkSerializable.md)

Defined in: [src/adapters/avalanche/sdk.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L53)

## Methods

<a id="amount"></a>

### amount()

> **amount**(): `bigint`

Defined in: [src/adapters/avalanche/sdk.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L54)

#### Returns

`bigint`
