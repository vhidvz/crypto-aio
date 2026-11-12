[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LockManager

# Interface: LockManager

Defined in: [src/core/store/types.ts:449](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L449)

Leases that serialize work on one key across processes, such as one sending address's
nonces. Required guarantees (verified by the contract suite):
- One holder per key at a time, among any number of concurrent acquirers; keys are
  independent.
- Tokens grow strictly per key across every acquisition, after an expiry or a release.

## Methods

<a id="acquire"></a>

### acquire()

> **acquire**(`key`, `owner`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:454](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L454)

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

`Promise`\<[`Lease`](Lease.md) \| `null`\>

***

<a id="release"></a>

### release()

> **release**(`lease`): `Promise`\<`void`\>

Defined in: [src/core/store/types.ts:461](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L461)

Frees the key if `lease` still holds it; a stale lease's release changes nothing.

#### Parameters

##### lease

[`Lease`](Lease.md)

#### Returns

`Promise`\<`void`\>

***

<a id="renew"></a>

### renew()

> **renew**(`lease`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:459](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L459)

Extends a lease still held for `ttlMs` more, keeping its token, or `null` once it
expired or another holder took the key.

#### Parameters

##### lease

[`Lease`](Lease.md)

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](Lease.md) \| `null`\>
