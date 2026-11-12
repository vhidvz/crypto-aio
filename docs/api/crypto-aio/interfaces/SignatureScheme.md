[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SignatureScheme

# Interface: SignatureScheme

Defined in: [src/core/registry/schemes.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/schemes.ts#L21)

A signature scheme the core verifies signatures with (`Plugin.schemes`); the built-in
ones are `secp256k1-ecdsa`, `secp256k1-schnorr` and `ed25519`.

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/registry/schemes.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/schemes.ts#L22)

***

<a id="publickeylength"></a>

### publicKeyLength

> `readonly` **publicKeyLength**: `number`

Defined in: [src/core/registry/schemes.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/schemes.ts#L24)

The length of a public key, in bytes.

## Methods

<a id="verify"></a>

### verify()

> **verify**(`input`): `boolean`

Defined in: [src/core/registry/schemes.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/schemes.ts#L26)

Whether the signature is valid; never throws.

#### Parameters

##### input

[`VerifyInput`](VerifyInput.md)

#### Returns

`boolean`
