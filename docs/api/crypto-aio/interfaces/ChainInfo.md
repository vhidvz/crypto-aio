[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainInfo

# Interface: ChainInfo

Defined in: [src/core/model/chain.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L41)

## Properties

<a id="defaultnetwork"></a>

### defaultNetwork

> `readonly` **defaultNetwork**: `string`

Defined in: [src/core/model/chain.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L48)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/model/chain.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L43)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/chain.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L42)

***

<a id="model"></a>

### model

> `readonly` **model**: `"account"` \| `"utxo"`

Defined in: [src/core/model/chain.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L44)

***

<a id="nativeasset"></a>

### nativeAsset

> `readonly` **nativeAsset**: [`NativeAssetInfo`](NativeAssetInfo.md)

Defined in: [src/core/model/chain.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L47)

***

<a id="networks"></a>

### networks

> `readonly` **networks**: `Readonly`\<`Record`\<`string`, [`NetworkInfo`](NetworkInfo.md)\>\>

Defined in: [src/core/model/chain.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L49)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingKind`](../type-aliases/OrderingKind.md)

Defined in: [src/core/model/chain.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L45)

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/model/chain.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L46)

***

<a id="xpubnetworkclass"></a>

### xpubNetworkClass?

> `readonly` `optional` **xpubNetworkClass?**: `boolean`

Defined in: [src/core/model/chain.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L55)

Whether the chain's extended public keys carry their network class (SLIP-0132: `xpub`
on mainnet, `tpub` on test networks), so `deriveAddress` refuses a key of the other
class (A20). Default: `true` for `utxo`-model chains, `false` for account-model ones.
