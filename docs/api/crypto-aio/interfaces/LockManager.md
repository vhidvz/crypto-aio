[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LockManager

# Interface: LockManager

Defined in: [src/core/store/types.ts:316](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L316)

## Methods

<a id="acquire"></a>

### acquire()

> **acquire**(`key`, `owner`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:317](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L317)

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

Defined in: [src/core/store/types.ts:319](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L319)

#### Parameters

##### lease

[`Lease`](Lease.md)

#### Returns

`Promise`\<`void`\>

***

<a id="renew"></a>

### renew()

> **renew**(`lease`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:318](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L318)

#### Parameters

##### lease

[`Lease`](Lease.md)

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](Lease.md) \| `null`\>
