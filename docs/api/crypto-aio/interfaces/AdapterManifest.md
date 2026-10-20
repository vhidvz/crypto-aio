[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AdapterManifest

# Interface: AdapterManifest

Defined in: [src/core/driver/types.ts:429](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L429)

Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module.

## Properties

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:433](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L433)

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly `string`[]

Defined in: [src/core/driver/types.ts:432](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L432)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/driver/types.ts:430](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L430)

***

<a id="indexercapabilities"></a>

### indexerCapabilities?

> `readonly` `optional` **indexerCapabilities?**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:434](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L434)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:431](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L431)

***

<a id="peerdependencies"></a>

### peerDependencies

> `readonly` **peerDependencies**: readonly [`PeerDependency`](PeerDependency.md)[]

Defined in: [src/core/driver/types.ts:436](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L436)

***

<a id="requiresindexer"></a>

### requiresIndexer?

> `readonly` `optional` **requiresIndexer?**: `boolean`

Defined in: [src/core/driver/types.ts:435](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L435)

## Methods

<a id="load"></a>

### load()

> **load**(): `Promise`\<[`DriverFactory`](DriverFactory.md)\>

Defined in: [src/core/driver/types.ts:437](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L437)

#### Returns

`Promise`\<[`DriverFactory`](DriverFactory.md)\>
