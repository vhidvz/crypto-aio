[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkBaseTx

# Interface: SdkBaseTx

Defined in: [src/adapters/avalanche/sdk.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L72)

The `avax.BaseTx` every X-Chain and most P-Chain transactions carry.

## Properties

<a id="blockchainid"></a>

### BlockchainId

> `readonly` **BlockchainId**: [`SdkId`](SdkId.md)

Defined in: [src/adapters/avalanche/sdk.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L74)

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: readonly [`SdkTransferableInput`](SdkTransferableInput.md)[]

Defined in: [src/adapters/avalanche/sdk.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L76)

***

<a id="memo"></a>

### memo

> `readonly` **memo**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L77)

#### bytes

> `readonly` **bytes**: `Uint8Array`

***

<a id="networkid"></a>

### NetworkId

> `readonly` **NetworkId**: [`SdkInt`](SdkInt.md)

Defined in: [src/adapters/avalanche/sdk.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L73)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`SdkTransferableOutput`](SdkTransferableOutput.md)[]

Defined in: [src/adapters/avalanche/sdk.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L75)
