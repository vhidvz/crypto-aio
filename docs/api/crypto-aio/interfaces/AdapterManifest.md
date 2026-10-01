[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AdapterManifest

# Interface: AdapterManifest

Defined in: [src/core/driver/types.ts:389](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L389)

Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module.

## Properties

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:393](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L393)

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly `string`[]

Defined in: [src/core/driver/types.ts:392](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L392)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/driver/types.ts:390](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L390)

***

<a id="indexercapabilities"></a>

### indexerCapabilities?

> `readonly` `optional` **indexerCapabilities?**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:394](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L394)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:391](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L391)

***

<a id="peerdependencies"></a>

### peerDependencies

> `readonly` **peerDependencies**: readonly [`PeerDependency`](PeerDependency.md)[]

Defined in: [src/core/driver/types.ts:396](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L396)

***

<a id="requiresindexer"></a>

### requiresIndexer?

> `readonly` `optional` **requiresIndexer?**: `boolean`

Defined in: [src/core/driver/types.ts:395](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L395)

## Methods

<a id="load"></a>

### load()

> **load**(): `Promise`\<[`DriverFactory`](DriverFactory.md)\>

Defined in: [src/core/driver/types.ts:397](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L397)

#### Returns

`Promise`\<[`DriverFactory`](DriverFactory.md)\>
