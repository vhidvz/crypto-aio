[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkBaseTx

# Interface: SdkBaseTx

Defined in: [src/adapters/avalanche/sdk.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L81)

The `avax.BaseTx` every X-Chain and most P-Chain transactions carry.

## Properties

<a id="blockchainid"></a>

### BlockchainId

> `readonly` **BlockchainId**: [`SdkId`](SdkId.md)

Defined in: [src/adapters/avalanche/sdk.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L83)

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: readonly [`SdkTransferableInput`](SdkTransferableInput.md)[]

Defined in: [src/adapters/avalanche/sdk.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L85)

***

<a id="memo"></a>

### memo

> `readonly` **memo**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L86)

#### bytes

> `readonly` **bytes**: `Uint8Array`

***

<a id="networkid"></a>

### NetworkId

> `readonly` **NetworkId**: [`SdkInt`](SdkInt.md)

Defined in: [src/adapters/avalanche/sdk.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L82)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly [`SdkTransferableOutput`](SdkTransferableOutput.md)[]

Defined in: [src/adapters/avalanche/sdk.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L84)
