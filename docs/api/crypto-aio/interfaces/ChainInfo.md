[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainInfo

# Interface: ChainInfo

Defined in: [src/core/model/chain.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L56)

A chain, as built in or as a plugin registers it.

## Properties

<a id="defaultnetwork"></a>

### defaultNetwork

> `readonly` **defaultNetwork**: `string`

Defined in: [src/core/model/chain.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L66)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/model/chain.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L59)

The chain family whose drivers serve it, such as `evm` or `utxo`.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/chain.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L57)

***

<a id="model"></a>

### model

> `readonly` **model**: `"account"` \| `"utxo"`

Defined in: [src/core/model/chain.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L60)

***

<a id="nativeasset"></a>

### nativeAsset

> `readonly` **nativeAsset**: [`NativeAssetInfo`](NativeAssetInfo.md)

Defined in: [src/core/model/chain.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L65)

***

<a id="networks"></a>

### networks

> `readonly` **networks**: `Readonly`\<`Record`\<`string`, [`NetworkInfo`](NetworkInfo.md)\>\>

Defined in: [src/core/model/chain.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L67)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingKind`](../type-aliases/OrderingKind.md)

Defined in: [src/core/model/chain.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L62)

How its transactions are ordered; its drivers must order the same way.

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/model/chain.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L64)

The signature schemes its wallets sign with.

***

<a id="xpubnetworkclass"></a>

### xpubNetworkClass?

> `readonly` `optional` **xpubNetworkClass?**: `boolean`

Defined in: [src/core/model/chain.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L73)

Whether the chain's extended public keys carry their network class (SLIP-0132: `xpub`
on mainnet, `tpub` on test networks), so `deriveAddress` refuses a key of the other
class. Default: `true` for `utxo`-model chains, `false` for account-model ones.
