[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AdapterManifest

# Interface: AdapterManifest

Defined in: [src/core/driver/types.ts:532](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L532)

Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module.

## Properties

<a id="capabilities"></a>

### capabilities

> `readonly` **capabilities**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:543](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L543)

The capabilities a handle on it has, before the network adds or removes any.

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly `string`[]

Defined in: [src/core/driver/types.ts:541](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L541)

The chain ids it serves.

***

<a id="family"></a>

### family

> `readonly` **family**: `string`

Defined in: [src/core/driver/types.ts:537](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L537)

The chain family, and the key the manifest registers under. A plugin chain of a
built-in family registers its own, such as `evm:<name>`.

***

<a id="indexercapabilities"></a>

### indexerCapabilities?

> `readonly` `optional` **indexerCapabilities?**: readonly [`Capability`](../type-aliases/Capability.md)[]

Defined in: [src/core/driver/types.ts:545](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L545)

Further capabilities a handle has when it has an `indexer` provider.

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:539](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L539)

The SDK library; the first manifest registered for a chain is its default library.

***

<a id="peerdependencies"></a>

### peerDependencies

> `readonly` **peerDependencies**: readonly [`PeerDependency`](PeerDependency.md)[]

Defined in: [src/core/driver/types.ts:552](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L552)

Checked when `load()` runs: a missing package fails with `DEPENDENCY_MISSING`.

***

<a id="requiresindexer"></a>

### requiresIndexer?

> `readonly` `optional` **requiresIndexer?**: `boolean`

Defined in: [src/core/driver/types.ts:550](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L550)

Whether a handle needs an `indexer` provider; without one it falls back to the
`public` preset, or fails with `CONFIG_INVALID` when the network has none.

## Methods

<a id="load"></a>

### load()

> **load**(): `Promise`\<[`DriverFactory`](DriverFactory.md)\>

Defined in: [src/core/driver/types.ts:554](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L554)

Loads the driver module (and its SDK) on first use.

#### Returns

`Promise`\<[`DriverFactory`](DriverFactory.md)\>
