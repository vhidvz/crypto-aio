[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryLockManager

# Class: MemoryLockManager

Defined in: [src/core/store/memory.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L25)

## Implements

- [`LockManager`](../interfaces/LockManager.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemoryLockManager**(`clock?`): `MemoryLockManager`

Defined in: [src/core/store/memory.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L29)

#### Parameters

##### clock?

[`Clock`](../interfaces/Clock.md) = `systemClock`

#### Returns

`MemoryLockManager`

## Methods

<a id="acquire"></a>

### acquire()

> **acquire**(`key`, `owner`, `ttlMs`): `Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

Defined in: [src/core/store/memory.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L31)

#### Parameters

##### key

`string`

##### owner

`string`

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

#### Implementation of

[`LockManager`](../interfaces/LockManager.md).[`acquire`](../interfaces/LockManager.md#acquire)

***

<a id="release"></a>

### release()

> **release**(`lease`): `Promise`\<`void`\>

Defined in: [src/core/store/memory.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L53)

#### Parameters

##### lease

[`Lease`](../interfaces/Lease.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`LockManager`](../interfaces/LockManager.md).[`release`](../interfaces/LockManager.md#release)

***

<a id="renew"></a>

### renew()

> **renew**(`lease`, `ttlMs`): `Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

Defined in: [src/core/store/memory.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L42)

#### Parameters

##### lease

[`Lease`](../interfaces/Lease.md)

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

#### Implementation of

[`LockManager`](../interfaces/LockManager.md).[`renew`](../interfaces/LockManager.md#renew)
