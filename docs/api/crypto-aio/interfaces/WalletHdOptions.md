[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WalletHdOptions

# Interface: WalletHdOptions

Defined in: [src/core/signing/wallet.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/wallet.ts#L33)

The wallet's extended public key as drivers receive it, `WalletOptions.hd`: plain,
frozen data, present only when the wallet configures a non-empty `xpub` (an empty
one counts as none, as in `deriveAddress`), which must be a readable PUBLIC extended key
(`CONFIG_INVALID` otherwise, naming no key).

## Properties

<a id="xpub"></a>

### xpub

> `readonly` **xpub**: `string`

Defined in: [src/core/signing/wallet.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/wallet.ts#L34)

***

<a id="xpubpath"></a>

### xpubPath?

> `readonly` `optional` **xpubPath?**: `string`

Defined in: [src/core/signing/wallet.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/wallet.ts#L36)

Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`.

***

<a id="xpubversions"></a>

### xpubVersions?

> `readonly` `optional` **xpubVersions?**: [`ExtendedKeyVersions`](ExtendedKeyVersions.md)

Defined in: [src/core/signing/wallet.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/wallet.ts#L37)
