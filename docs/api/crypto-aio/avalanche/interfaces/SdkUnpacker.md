[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkUnpacker

# Interface: SdkUnpacker\<T\>

Defined in: [src/adapters/avalanche/sdk.ts:124](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L124)

A class `Manager.unpack` reads (`Utxo`, `avaxSerial.SignedTx`).

## Type Parameters

<a id="t"></a>

### T

`T`

## Methods

<a id="frombytes"></a>

### fromBytes()

> **fromBytes**(`bytes`, `codec`): \[`T`, `Uint8Array`\<`ArrayBufferLike`\>\]

Defined in: [src/adapters/avalanche/sdk.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L125)

#### Parameters

##### bytes

`Uint8Array`

##### codec

`unknown`

#### Returns

\[`T`, `Uint8Array`\<`ArrayBufferLike`\>\]
