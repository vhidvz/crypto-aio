[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryLockManager

# Class: MemoryLockManager

Defined in: [src/core/store/memory.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L26)

A `LockManager` in this process's memory: for tests and one-process use only.

## Implements

- [`LockManager`](../interfaces/LockManager.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemoryLockManager**(`clock?`): `MemoryLockManager`

Defined in: [src/core/store/memory.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L30)

#### Parameters

##### clock?

[`Clock`](../interfaces/Clock.md) = `systemClock`

#### Returns

`MemoryLockManager`

## Methods

<a id="acquire"></a>

### acquire()

> **acquire**(`key`, `owner`, `ttlMs`): `Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

Defined in: [src/core/store/memory.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L32)

A lease on `key` for `ttlMs`, or `null` while another lease on it is unexpired. Leases
are not reentrant: the same owner gets `null` too.

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

Defined in: [src/core/store/memory.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L54)

Frees the key if `lease` still holds it; a stale lease's release changes nothing.

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

Defined in: [src/core/store/memory.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L43)

Extends a lease still held for `ttlMs` more, keeping its token, or `null` once it
expired or another holder took the key.

#### Parameters

##### lease

[`Lease`](../interfaces/Lease.md)

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](../interfaces/Lease.md) \| `null`\>

#### Implementation of

[`LockManager`](../interfaces/LockManager.md).[`renew`](../interfaces/LockManager.md#renew)
