[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AdapterManifest

# Interface: AdapterManifest

Defined in: [src/core/driver/types.ts:395](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L395)

Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module.

## Properties

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:399](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L399)

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly `string`[]

Defined in: [src/core/driver/types.ts:398](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L398)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/driver/types.ts:396](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L396)

***

<a id="indexercapabilities"></a>

### indexerCapabilities?

> `readonly` `optional` **indexerCapabilities?**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:400](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L400)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:397](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L397)

***

<a id="peerdependencies"></a>

### peerDependencies

> `readonly` **peerDependencies**: readonly [`PeerDependency`](PeerDependency.md)[]

Defined in: [src/core/driver/types.ts:402](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L402)

***

<a id="requiresindexer"></a>

### requiresIndexer?

> `readonly` `optional` **requiresIndexer?**: `boolean`

Defined in: [src/core/driver/types.ts:401](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L401)

## Methods

<a id="load"></a>

### load()

> **load**(): `Promise`\<[`DriverFactory`](DriverFactory.md)\>

Defined in: [src/core/driver/types.ts:403](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L403)

#### Returns

`Promise`\<[`DriverFactory`](DriverFactory.md)\>
