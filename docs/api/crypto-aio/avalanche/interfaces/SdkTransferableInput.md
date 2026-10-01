[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkTransferableInput

# Interface: SdkTransferableInput

Defined in: [src/adapters/avalanche/sdk.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L56)

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

Defined in: [src/adapters/avalanche/sdk.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L58)

***

<a id="utxoid"></a>

### utxoID

> `readonly` **utxoID**: [`SdkUtxoId`](SdkUtxoId.md)

Defined in: [src/adapters/avalanche/sdk.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L57)

## Methods

<a id="amount"></a>

### amount()

> **amount**(): `bigint`

Defined in: [src/adapters/avalanche/sdk.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L59)

#### Returns

`bigint`

***

<a id="sigindicies"></a>

### sigIndicies()

> **sigIndicies**(): `number`[]

Defined in: [src/adapters/avalanche/sdk.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L60)

#### Returns

`number`[]
