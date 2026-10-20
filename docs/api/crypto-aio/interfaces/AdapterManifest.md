[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AdapterManifest

# Interface: AdapterManifest

Defined in: [src/core/driver/types.ts:418](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L418)

Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module.

## Properties

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:422](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L422)

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly `string`[]

Defined in: [src/core/driver/types.ts:421](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L421)

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/driver/types.ts:419](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L419)

***

<a id="indexercapabilities"></a>

### indexerCapabilities?

> `readonly` `optional` **indexerCapabilities?**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:423](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L423)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:420](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L420)

***

<a id="peerdependencies"></a>

### peerDependencies

> `readonly` **peerDependencies**: readonly [`PeerDependency`](PeerDependency.md)[]

Defined in: [src/core/driver/types.ts:425](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L425)

***

<a id="requiresindexer"></a>

### requiresIndexer?

> `readonly` `optional` **requiresIndexer?**: `boolean`

Defined in: [src/core/driver/types.ts:424](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L424)

## Methods

<a id="load"></a>

### load()

> **load**(): `Promise`\<[`DriverFactory`](DriverFactory.md)\>

Defined in: [src/core/driver/types.ts:426](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L426)

#### Returns

`Promise`\<[`DriverFactory`](DriverFactory.md)\>
