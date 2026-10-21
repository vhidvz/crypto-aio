[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CryptoAio

# Class: CryptoAio

Defined in: [src/core/container/container.ts:342](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L342)

Dependency container: stores, signers, wallets, hooks, plugins and a shared driver pool.
Separate `new CryptoAio()` instances are fully isolated (use one per tenant).

## Constructors

<a id="constructor"></a>

### Constructor

> **new CryptoAio**(`options?`): `CryptoAio`

Defined in: [src/core/container/container.ts:345](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L345)

#### Parameters

##### options?

[`AioOptions`](../interfaces/AioOptions.md) = `{}`

#### Returns

`CryptoAio`

## Properties

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/container/container.ts:343](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L343)

## Accessors

<a id="monitor"></a>

### monitor

#### Get Signature

> **get** **monitor**(): [`MonitorApi`](../interfaces/MonitorApi.md)

Defined in: [src/core/container/container.ts:544](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L544)

Background workers that check due Operations without anyone waiting on them.

##### Returns

[`MonitorApi`](../interfaces/MonitorApi.md)

***

<a id="operations"></a>

### operations

#### Get Signature

> **get** **operations**(): [`OperationsApi`](../interfaces/OperationsApi.md)

Defined in: [src/core/container/container.ts:512](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L512)

Stored Operations of this namespace, as views, and startup recovery.

##### Returns

[`OperationsApi`](../interfaces/OperationsApi.md)

## Methods

<a id="blockchain"></a>

### blockchain()

> **blockchain**\<`C`\>(`config`): [`Blockchain`](Blockchain.md)\<`C`\>

Defined in: [src/core/container/container.ts:427](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L427)

#### Type Parameters

##### C

`C` *extends* [`ChainId`](../type-aliases/ChainId.md)

#### Parameters

##### config

[`HandleConfig`](../type-aliases/HandleConfig.md)\<`C`\>

#### Returns

[`Blockchain`](Blockchain.md)\<`C`\>

***

<a id="close"></a>

### close()

> **close**(): `Promise`\<`void`\>

Defined in: [src/core/container/container.ts:567](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L567)

Closes the root container: runs the `close` of every native client that
`crypto-aio/native` handed out (a failing one is logged by code and skipped), then
closes the pooled drivers. Its handles and `native()` then fail with
`INVALID_TRANSITION`. A scope's `close()` does nothing; scopes share their root's pool.

#### Returns

`Promise`\<`void`\>

***

<a id="on"></a>

### on()

> **on**\<`E`\>(`type`, `handler`): () => `void`

Defined in: [src/core/container/container.ts:503](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L503)

#### Type Parameters

##### E

`E` *extends* keyof [`AioEvents`](../interfaces/AioEvents.md)

#### Parameters

##### type

`E`

##### handler

(`event`) => `void`

#### Returns

() => `void`

***

<a id="onany"></a>

### onAny()

> **onAny**(`handler`): () => `void`

Defined in: [src/core/container/container.ts:507](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L507)

#### Parameters

##### handler

(`event`) => `void`

#### Returns

() => `void`

***

<a id="scope"></a>

### scope()

> **scope**(`overrides`): `CryptoAio`

Defined in: [src/core/container/container.ts:418](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L418)

Child container: inherits config, pool, stores and namespace; overrides merge on top.
Not a tenant boundary — a scope shares its root's pool and stores. Use a separate
`new CryptoAio({ namespace })` when isolation between tenants is required.

#### Parameters

##### overrides

[`ScopeOptions`](../interfaces/ScopeOptions.md)

#### Returns

`CryptoAio`

***

<a id="use"></a>

### use()

> **use**(`plugin`): `this`

Defined in: [src/core/container/container.ts:482](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L482)

Registers a plugin on this root container (copy-on-write catalogs).

#### Parameters

##### plugin

[`Plugin`](../interfaces/Plugin.md)

#### Returns

`this`
