[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / AvalancheSdk

# Interface: AvalancheSdk

Defined in: [src/adapters/avalanche/sdk.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L155)

The members of `@avalabs/avalanchejs` this library calls.

## Properties

<a id="avaxserial"></a>

### avaxSerial

> `readonly` **avaxSerial**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L157)

#### SignedTx

> `readonly` **SignedTx**: [`SdkUnpacker`](SdkUnpacker.md)\<[`SdkSignedTx`](SdkSignedTx.md)\> & (`tx`, `credentials`) => [`SdkSignedTx`](SdkSignedTx.md)

***

<a id="avm"></a>

### avm

> `readonly` **avm**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:184](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L184)

#### newBaseTx()

> **newBaseTx**(`context`, `fromAddressesBytes`, `utxos`, `outputs`, `options`): [`SdkUnsignedTx`](SdkUnsignedTx.md)

##### Parameters

###### context

[`SdkContext`](SdkContext.md)

###### fromAddressesBytes

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### utxos

readonly [`SdkUtxo`](SdkUtxo.md)[]

###### outputs

readonly [`SdkTransferableOutput`](SdkTransferableOutput.md)[]

###### options

###### changeAddresses

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### memo

`Uint8Array`

###### minIssuanceTime

`bigint`

##### Returns

[`SdkUnsignedTx`](SdkUnsignedTx.md)

***

<a id="common"></a>

### Common

> `readonly` **Common**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:172](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L172)

#### createDimensions()

> **createDimensions**(`dimensions`): [`SdkDimensions`](SdkDimensions.md)

##### Parameters

###### dimensions

###### bandwidth

`number`

###### compute

`number`

###### dbRead

`number`

###### dbWrite

`number`

##### Returns

[`SdkDimensions`](SdkDimensions.md)

***

<a id="credential"></a>

### Credential

> `readonly` **Credential**: (`signatures`) => [`SdkCredential`](SdkCredential.md)

Defined in: [src/adapters/avalanche/sdk.ts:161](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L161)

#### Parameters

##### signatures

[`SdkSignature`](SdkSignature.md)[]

#### Returns

[`SdkCredential`](SdkCredential.md)

***

<a id="pvm"></a>

### pvm

> `readonly` **pvm**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:197](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L197)

#### calculateFee()

> **calculateFee**(`tx`, `weights`, `price`): `bigint`

##### Parameters

###### tx

[`SdkTransaction`](SdkTransaction.md)

###### weights

[`SdkDimensions`](SdkDimensions.md)

###### price

`bigint`

##### Returns

`bigint`

#### newBaseTx()

> **newBaseTx**(`props`, `context`): [`SdkUnsignedTx`](SdkUnsignedTx.md)

##### Parameters

###### props

###### changeAddressesBytes

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### feeState

[`SdkFeeState`](SdkFeeState.md)

###### fromAddressesBytes

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### memo

`Uint8Array`

###### minIssuanceTime

`bigint`

###### outputs

readonly [`SdkTransferableOutput`](SdkTransferableOutput.md)[]

###### utxos

readonly [`SdkUtxo`](SdkUtxo.md)[]

###### context

[`SdkContext`](SdkContext.md)

##### Returns

[`SdkUnsignedTx`](SdkUnsignedTx.md)

***

<a id="signature"></a>

### Signature

> `readonly` **Signature**: (`bytes`) => [`SdkSignature`](SdkSignature.md)

Defined in: [src/adapters/avalanche/sdk.ts:162](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L162)

#### Parameters

##### bytes

`Uint8Array`

#### Returns

[`SdkSignature`](SdkSignature.md)

***

<a id="transferableoutput"></a>

### TransferableOutput

> `readonly` **TransferableOutput**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:163](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L163)

#### fromNative()

> **fromNative**(`assetId`, `amount`, `addresses`, `locktime?`, `threshold?`): [`SdkTransferableOutput`](SdkTransferableOutput.md)

##### Parameters

###### assetId

`string`

###### amount

`bigint`

###### addresses

readonly `Uint8Array`\<`ArrayBufferLike`\>[]

###### locktime?

`bigint`

###### threshold?

`number`

##### Returns

[`SdkTransferableOutput`](SdkTransferableOutput.md)

***

<a id="utils"></a>

### utils

> `readonly` **utils**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:180](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L180)

#### getBurnedAmountByTx()

> **getBurnedAmountByTx**(`tx`, `context`): `Map`\<`string`, `bigint`\>

##### Parameters

###### tx

[`SdkTransaction`](SdkTransaction.md)

###### context

[`SdkContext`](SdkContext.md)

##### Returns

`Map`\<`string`, `bigint`\>

#### getManagerForVM()

> **getManagerForVM**(`vm`): [`SdkManager`](SdkManager.md)

##### Parameters

###### vm

`"AVM"` \| `"PVM"`

##### Returns

[`SdkManager`](SdkManager.md)

***

<a id="utxo"></a>

### Utxo

> `readonly` **Utxo**: [`SdkUnpacker`](SdkUnpacker.md)\<[`SdkUtxo`](SdkUtxo.md)\>

Defined in: [src/adapters/avalanche/sdk.ts:156](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L156)
