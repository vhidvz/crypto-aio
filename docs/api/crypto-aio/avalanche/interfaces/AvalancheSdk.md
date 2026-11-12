[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / AvalancheSdk

# Interface: AvalancheSdk

Defined in: [src/adapters/avalanche/sdk.ts:170](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L170)

The members of `@avalabs/avalanchejs` this library calls.

## Properties

<a id="avaxserial"></a>

### avaxSerial

> `readonly` **avaxSerial**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:172](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L172)

#### SignedTx

> `readonly` **SignedTx**: [`SdkUnpacker`](SdkUnpacker.md)\<[`SdkSignedTx`](SdkSignedTx.md)\> & (new (`tx`, `credentials`) => [`SdkSignedTx`](SdkSignedTx.md))

***

<a id="avm"></a>

### avm

> `readonly` **avm**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:199](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L199)

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

Defined in: [src/adapters/avalanche/sdk.ts:187](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L187)

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

> `readonly` **Credential**: new (`signatures`) => [`SdkCredential`](SdkCredential.md)

Defined in: [src/adapters/avalanche/sdk.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L176)

#### Parameters

##### signatures

[`SdkSignature`](SdkSignature.md)[]

#### Returns

[`SdkCredential`](SdkCredential.md)

***

<a id="pvm"></a>

### pvm

> `readonly` **pvm**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:212](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L212)

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

> `readonly` **Signature**: new (`bytes`) => [`SdkSignature`](SdkSignature.md)

Defined in: [src/adapters/avalanche/sdk.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L177)

#### Parameters

##### bytes

`Uint8Array`

#### Returns

[`SdkSignature`](SdkSignature.md)

***

<a id="transferableoutput"></a>

### TransferableOutput

> `readonly` **TransferableOutput**: `object`

Defined in: [src/adapters/avalanche/sdk.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L178)

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

Defined in: [src/adapters/avalanche/sdk.ts:195](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L195)

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

Defined in: [src/adapters/avalanche/sdk.ts:171](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L171)
