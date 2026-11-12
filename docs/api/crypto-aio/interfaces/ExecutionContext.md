[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ExecutionContext

# Interface: ExecutionContext

Defined in: [src/core/store/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L63)

Frozen at Operation creation; later handle or config changes never affect it.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/store/types.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L65)

The chain id, such as `ethereum`.

***

<a id="confighash"></a>

### configHash

> `readonly` **configHash**: `string`

Defined in: [src/core/store/types.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L83)

A hash of the handle's resolved selection (chain, network, library, provider and
indexer names, wallet, signer, options, confirmations): workers rebuild one handle per
hash to check the Operations created through it.

***

<a id="indexers"></a>

### indexers

> `readonly` **indexers**: readonly `string`[]

Defined in: [src/core/store/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L73)

Indexer provider names, named as `providers` are.

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/store/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L69)

The SDK library the driver used, such as `ethers`.

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/store/types.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L67)

The network id, such as `mainnet`.

***

<a id="providers"></a>

### providers

> `readonly` **providers**: readonly `string`[]

Defined in: [src/core/store/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L71)

Provider names, or `inline:<hash>` for inline configs (never secrets).

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/store/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L77)

The signer's id, when the wallet signs through a registered signer.

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: `string`

Defined in: [src/core/store/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L75)

The configured wallet's name.
