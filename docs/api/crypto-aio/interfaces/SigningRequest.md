[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SigningRequest

# Interface: SigningRequest

Defined in: [src/core/signing/types.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L20)

One signature to make. The core verifies every signature against its request.

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/signing/types.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L22)

Identifies the request; the signature answers it by `requestId`.

***

<a id="keyref"></a>

### keyRef?

> `readonly` `optional` **keyRef?**: [`KeyRef`](KeyRef.md)

Defined in: [src/core/signing/types.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L30)

***

<a id="params"></a>

### params?

> `readonly` `optional` **params?**: [`SigningParams`](SigningParams.md)

Defined in: [src/core/signing/types.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L32)

For a Bitcoin `p2tr` key-path spend, the BIP341 tweak to apply to the key.

***

<a id="payload"></a>

### payload

> `readonly` **payload**: `Uint8Array`

Defined in: [src/core/signing/types.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L26)

What to sign: a 32-byte digest, or the whole message for `ed25519`.

***

<a id="payloadkind"></a>

### payloadKind

> `readonly` **payloadKind**: `"digest"` \| `"message"`

Defined in: [src/core/signing/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L27)

***

<a id="publickey"></a>

### publicKey

> `readonly` **publicKey**: `Uint8Array`

Defined in: [src/core/signing/types.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L29)

The key that must sign, as the wallet resolved it.

***

<a id="scheme"></a>

### scheme

> `readonly` **scheme**: `string`

Defined in: [src/core/signing/types.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L24)

The signature scheme, such as `secp256k1-ecdsa`, `secp256k1-schnorr` or `ed25519`.
