[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkUnpacker

# Interface: SdkUnpacker\<T\>

Defined in: [src/adapters/avalanche/sdk.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L112)

A class `Manager.unpack` reads (`Utxo`, `avaxSerial.SignedTx`).

## Type Parameters

### T

`T`

## Methods

<a id="frombytes"></a>

### fromBytes()

> **fromBytes**(`bytes`, `codec`): \[`T`, `Uint8Array`\<`ArrayBufferLike`\>\]

Defined in: [src/adapters/avalanche/sdk.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L113)

#### Parameters

##### bytes

`Uint8Array`

##### codec

`unknown`

#### Returns

\[`T`, `Uint8Array`\<`ArrayBufferLike`\>\]
