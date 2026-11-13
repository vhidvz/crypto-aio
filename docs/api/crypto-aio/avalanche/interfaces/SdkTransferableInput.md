[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkTransferableInput

# Interface: SdkTransferableInput

Defined in: [src/adapters/avalanche/sdk.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L64)

The part of avalanchejs's `TransferableInput` this library uses; it mirrors the SDK, outside semver.

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

Defined in: [src/adapters/avalanche/sdk.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L66)

***

<a id="utxoid"></a>

### utxoID

> `readonly` **utxoID**: [`SdkUtxoId`](SdkUtxoId.md)

Defined in: [src/adapters/avalanche/sdk.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L65)

## Methods

<a id="amount"></a>

### amount()

> **amount**(): `bigint`

Defined in: [src/adapters/avalanche/sdk.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L67)

#### Returns

`bigint`

***

<a id="sigindicies"></a>

### sigIndicies()

> **sigIndicies**(): `number`[]

Defined in: [src/adapters/avalanche/sdk.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L68)

#### Returns

`number`[]
