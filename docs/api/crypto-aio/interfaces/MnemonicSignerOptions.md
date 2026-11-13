[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MnemonicSignerOptions

# Interface: MnemonicSignerOptions

Defined in: [src/core/signing/local.ts:255](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L255)

`localSigner.fromMnemonic()`'s options: the BIP39 `passphrase`, the curves to derive
(default both), the signer's `id` and whether keys are exportable.

## Properties

<a id="curves"></a>

### curves?

> `readonly` `optional` **curves?**: readonly [`Curve`](../type-aliases/Curve.md)[]

Defined in: [src/core/signing/local.ts:259](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L259)

***

<a id="exportable"></a>

### exportable?

> `readonly` `optional` **exportable?**: `boolean`

Defined in: [src/core/signing/local.ts:258](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L258)

***

<a id="id"></a>

### id?

> `readonly` `optional` **id?**: `string`

Defined in: [src/core/signing/local.ts:256](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L256)

***

<a id="passphrase"></a>

### passphrase?

> `readonly` `optional` **passphrase?**: [`Secret`](../classes/Secret.md)\<`string`\>

Defined in: [src/core/signing/local.ts:257](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L257)
