[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SigningParams

# Interface: SigningParams

Defined in: [src/core/signing/types.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L14)

Scheme-specific parameters of a signing request.

## Properties

<a id="tweak"></a>

### tweak?

> `readonly` `optional` **tweak?**: `Uint8Array`\<`ArrayBufferLike`\>

Defined in: [src/core/signing/types.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L16)

BIP341 key-path tweak for `secp256k1-schnorr`.
