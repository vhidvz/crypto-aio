[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CryptoAio

# Class: CryptoAio

Defined in: [src/core/container/container.ts:315](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L315)

Dependency container: stores, signers, wallets, hooks, plugins and a shared driver pool.
Separate `new CryptoAio()` instances are fully isolated (use one per tenant).

## Constructors

<a id="constructor"></a>

### Constructor

> **new CryptoAio**(`options?`): `CryptoAio`

Defined in: [src/core/container/container.ts:318](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L318)

#### Parameters

##### options?

[`AioOptions`](../interfaces/AioOptions.md)

#### Returns

`CryptoAio`

## Properties

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/container/container.ts:316](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L316)

## Accessors

<a id="monitor"></a>

### monitor

#### Get Signature

> **get** **monitor**(): [`MonitorApi`](../interfaces/MonitorApi.md)

Defined in: [src/core/container/container.ts:509](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L509)

Background workers that check due Operations without anyone waiting on them.

##### Returns

[`MonitorApi`](../interfaces/MonitorApi.md)

***

<a id="operations"></a>

### operations

#### Get Signature

> **get** **operations**(): [`OperationsApi`](../interfaces/OperationsApi.md)

Defined in: [src/core/container/container.ts:477](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L477)

Stored Operations of this namespace, as views, and startup recovery.

##### Returns

[`OperationsApi`](../interfaces/OperationsApi.md)

## Methods

<a id="blockchain"></a>

### blockchain()

> **blockchain**\<`C`\>(`config`): [`Blockchain`](Blockchain.md)\<`C`\>

Defined in: [src/core/container/container.ts:392](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L392)

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

Defined in: [src/core/container/container.ts:532](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L532)

Closes the root container (R34): runs the `close` of every native client that
`crypto-aio/native` handed out (a failing one is logged by code and skipped), then
closes the pooled drivers. Its handles and `native()` then fail with
`INVALID_TRANSITION`. A scope's `close()` does nothing; scopes share their root's pool.

#### Returns

`Promise`\<`void`\>

***

<a id="on"></a>

### on()

> **on**\<`E`\>(`type`, `handler`): () => `void`

Defined in: [src/core/container/container.ts:468](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L468)

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

Defined in: [src/core/container/container.ts:472](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L472)

#### Parameters

##### handler

(`event`) => `void`

#### Returns

() => `void`

***

<a id="scope"></a>

### scope()

> **scope**(`overrides`): `CryptoAio`

Defined in: [src/core/container/container.ts:388](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L388)

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

Defined in: [src/core/container/container.ts:447](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L447)

Registers a plugin on this root container (copy-on-write catalogs).

#### Parameters

##### plugin

[`Plugin`](../interfaces/Plugin.md)

#### Returns

`this`
