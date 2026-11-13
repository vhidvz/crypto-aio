[crypto-aio](../../index.md) / [crypto-aio](../index.md) / GeneratedSigner

# Interface: GeneratedSigner

Defined in: [src/core/signing/local.ts:191](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L191)

A signer over freshly generated keys, with their public keys.

## Properties

<a id="publickeys"></a>

### publicKeys

> `readonly` **publicKeys**: `Readonly`\<`Partial`\<`Record`\<[`Curve`](../type-aliases/Curve.md), `Uint8Array`\>\>\>

Defined in: [src/core/signing/local.ts:194](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L194)

secp256k1: 33-byte compressed; ed25519: 32 bytes.

***

<a id="signer"></a>

### signer

> `readonly` **signer**: [`Signer`](Signer.md)

Defined in: [src/core/signing/local.ts:192](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L192)
