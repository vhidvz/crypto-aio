[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NetworkStatus

# Interface: NetworkStatus

Defined in: [src/core/blockchain/handle.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L73)

`bc.getNetworkStatus()`'s answer: the chain's head and finalized heights as the handle's
endpoints report them, and each provider and indexer endpoint's health.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/blockchain/handle.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L74)

***

<a id="endpoints"></a>

### endpoints

> `readonly` **endpoints**: readonly [`EndpointStatus`](EndpointStatus.md)[]

Defined in: [src/core/blockchain/handle.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L78)

***

<a id="finalizedheight"></a>

### finalizedHeight

> `readonly` **finalizedHeight**: `bigint`

Defined in: [src/core/blockchain/handle.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L77)

***

<a id="height"></a>

### height

> `readonly` **height**: `bigint`

Defined in: [src/core/blockchain/handle.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L76)

***

<a id="indexers"></a>

### indexers

> `readonly` **indexers**: readonly [`EndpointStatus`](EndpointStatus.md)[]

Defined in: [src/core/blockchain/handle.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L79)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/blockchain/handle.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/blockchain/handle.ts#L75)
