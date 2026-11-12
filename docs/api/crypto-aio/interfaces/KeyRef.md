[crypto-aio](../../index.md) / [crypto-aio](../index.md) / KeyRef

# Interface: KeyRef

Defined in: [src/core/signing/types.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L6)

Which key a signer uses, for a signer that holds several.

## Properties

<a id="id"></a>

### id?

> `readonly` `optional` **id?**: `string`

Defined in: [src/core/signing/types.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L8)

Routes a request to a specific signer through `WalletConfig.signers`.

***

<a id="path"></a>

### path?

> `readonly` `optional` **path?**: `string`

Defined in: [src/core/signing/types.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L10)

HD derivation path for mnemonic-backed signers.
