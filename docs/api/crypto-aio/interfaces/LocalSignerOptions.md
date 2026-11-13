[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LocalSignerOptions

# Interface: LocalSignerOptions

Defined in: [src/core/signing/local.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L176)

`localSigner()`'s options: a raw private key per curve (hex or bytes, as a `secret`), the
signer's `id` (default `'local'`), and whether `exportKey` may hand a key out (default
`false`, `KEY_NOT_EXPORTABLE`).

## Properties

<a id="ed25519"></a>

### ed25519?

> `readonly` `optional` **ed25519?**: [`Secret`](../classes/Secret.md)\<`string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: [src/core/signing/local.ts:179](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L179)

***

<a id="exportable"></a>

### exportable?

> `readonly` `optional` **exportable?**: `boolean`

Defined in: [src/core/signing/local.ts:180](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L180)

***

<a id="id"></a>

### id?

> `readonly` `optional` **id?**: `string`

Defined in: [src/core/signing/local.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L177)

***

<a id="secp256k1"></a>

### secp256k1?

> `readonly` `optional` **secp256k1?**: [`Secret`](../classes/Secret.md)\<`string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: [src/core/signing/local.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L178)
