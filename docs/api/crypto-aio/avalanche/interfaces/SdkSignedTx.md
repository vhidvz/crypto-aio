[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / SdkSignedTx

# Interface: SdkSignedTx

Defined in: [src/adapters/avalanche/sdk.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L103)

The part of avalanchejs's `SignedTx` this library uses; it mirrors the SDK, outside semver.

## Properties

<a id="unsignedtx"></a>

### unsignedTx

> `readonly` **unsignedTx**: [`SdkTransaction`](SdkTransaction.md)

Defined in: [src/adapters/avalanche/sdk.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L104)

## Methods

<a id="getcredentials"></a>

### getCredentials()

> **getCredentials**(): [`SdkCredential`](SdkCredential.md)[]

Defined in: [src/adapters/avalanche/sdk.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L105)

#### Returns

[`SdkCredential`](SdkCredential.md)[]

***

<a id="tobytes"></a>

### toBytes()

> **toBytes**(): `Uint8Array`

Defined in: [src/adapters/avalanche/sdk.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/sdk.ts#L106)

#### Returns

`Uint8Array`
