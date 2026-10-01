[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SignatureBundle

# Interface: SignatureBundle

Defined in: [src/core/signing/types.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L28)

`secp256k1-ecdsa`: 64-byte compact r‖s (low-s) plus `recovery`; others: raw signature.

## Properties

<a id="bytes"></a>

### bytes

> `readonly` **bytes**: `Uint8Array`

Defined in: [src/core/signing/types.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L30)

***

<a id="recovery"></a>

### recovery?

> `readonly` `optional` **recovery?**: `number`

Defined in: [src/core/signing/types.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L31)

***

<a id="requestid"></a>

### requestId

> `readonly` **requestId**: `string`

Defined in: [src/core/signing/types.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L29)
