[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SignatureBundle

# Interface: SignatureBundle

Defined in: [src/core/signing/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L41)

A signature for one request. `secp256k1-ecdsa`: 64-byte compact r‖s (low-s) plus
`recovery`; `secp256k1-schnorr`: a 64-byte BIP340 signature (by the tweaked key when the
request has a tweak); `ed25519`: a 64-byte RFC 8032 signature; another scheme: its raw
signature.

## Properties

<a id="bytes"></a>

### bytes

> `readonly` **bytes**: `Uint8Array`

Defined in: [src/core/signing/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L43)

***

<a id="recovery"></a>

### recovery?

> `readonly` `optional` **recovery?**: `number`

Defined in: [src/core/signing/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L44)

***

<a id="requestid"></a>

### requestId

> `readonly` **requestId**: `string`

Defined in: [src/core/signing/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L42)
