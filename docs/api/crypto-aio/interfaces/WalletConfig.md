[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WalletConfig

# Interface: WalletConfig

Defined in: [src/core/config/types.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L24)

## Properties

<a id="address"></a>

### address?

> `readonly` `optional` **address?**: `string`

Defined in: [src/core/config/types.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L28)

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: readonly `string`[]

Defined in: [src/core/config/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L38)

***

<a id="keyref"></a>

### keyRef?

> `readonly` `optional` **keyRef?**: [`KeyRef`](KeyRef.md)

Defined in: [src/core/config/types.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L35)

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L41)

***

<a id="publickey"></a>

### publicKey?

> `readonly` `optional` **publicKey?**: `string`

Defined in: [src/core/config/types.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L30)

Hex public key for watch-only wallets that still prepare transactions.

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/config/types.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L25)

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/config/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L27)

Routes requests to signers by `keyRef.id` (multi-party wallets).

***

<a id="tier"></a>

### tier?

> `readonly` `optional` **tier?**: `string`

Defined in: [src/core/config/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L37)

Metadata only (passed to signing context); no built-in behaviour.

***

<a id="ton"></a>

### ton?

> `readonly` `optional` **ton?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L40)

***

<a id="utxo"></a>

### utxo?

> `readonly` `optional` **utxo?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L39)

***

<a id="xpub"></a>

### xpub?

> `readonly` `optional` **xpub?**: `string`

Defined in: [src/core/config/types.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L31)

***

<a id="xpubpath"></a>

### xpubPath?

> `readonly` `optional` **xpubPath?**: `string`

Defined in: [src/core/config/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L34)

Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`.

***

<a id="xpubversions"></a>

### xpubVersions?

> `readonly` `optional` **xpubVersions?**: [`ExtendedKeyVersions`](ExtendedKeyVersions.md)

Defined in: [src/core/config/types.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L32)
