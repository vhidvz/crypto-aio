[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WalletConfig

# Interface: WalletConfig

Defined in: [src/core/config/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L34)

A wallet: which key sends, through which signer. Without a signer it is watch-only: it
reads, and with `publicKey` it prepares transactions for signing elsewhere.

## Properties

<a id="address"></a>

### address?

> `readonly` `optional` **address?**: `string`

Defined in: [src/core/config/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L40)

The address of a watch-only wallet.

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: readonly `string`[]

Defined in: [src/core/config/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L54)

The chains this wallet may be used on.

***

<a id="keyref"></a>

### keyRef?

> `readonly` `optional` **keyRef?**: [`KeyRef`](KeyRef.md)

Defined in: [src/core/config/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L50)

Which key of the signer, such as a derivation path for a mnemonic signer.

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L66)

Further family wallet options.

***

<a id="publickey"></a>

### publicKey?

> `readonly` `optional` **publicKey?**: `string`

Defined in: [src/core/config/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L42)

Hex public key for watch-only wallets that still prepare transactions.

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/config/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L36)

The name of the signer (in `signers`) that holds the key.

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/config/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L38)

Routes requests to signers by `keyRef.id` (multi-party wallets).

***

<a id="tier"></a>

### tier?

> `readonly` `optional` **tier?**: `string`

Defined in: [src/core/config/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L52)

Metadata only (passed to signing context); no built-in behaviour.

***

<a id="ton"></a>

### ton?

> `readonly` `optional` **ton?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L64)

TON wallet settings (`TonWalletIdentity` from `crypto-aio/ton`). A plain record
through 1.x; the family type names the shape it accepts.

***

<a id="utxo"></a>

### utxo?

> `readonly` `optional` **utxo?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L59)

Bitcoin wallet settings (`UtxoWalletOptions` from `crypto-aio/utxo`). A plain record
through 1.x; the family type names the shape it accepts.

***

<a id="xpub"></a>

### xpub?

> `readonly` `optional` **xpub?**: `string`

Defined in: [src/core/config/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L44)

An extended public key, for deposit addresses from `deriveAddress`.

***

<a id="xpubpath"></a>

### xpubPath?

> `readonly` `optional` **xpubPath?**: `string`

Defined in: [src/core/config/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L48)

Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`.

***

<a id="xpubversions"></a>

### xpubVersions?

> `readonly` `optional` **xpubVersions?**: [`ExtendedKeyVersions`](ExtendedKeyVersions.md)

Defined in: [src/core/config/types.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L46)

The version bytes of a non-standard `xpub`.
