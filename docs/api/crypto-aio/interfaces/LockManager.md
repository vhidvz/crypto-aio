[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LockManager

# Interface: LockManager

Defined in: [src/core/store/types.ts:324](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L324)

## Methods

<a id="acquire"></a>

### acquire()

> **acquire**(`key`, `owner`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:325](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L325)

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

Defined in: [src/core/store/types.ts:327](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L327)

#### Parameters

##### lease

[`Lease`](Lease.md)

#### Returns

`Promise`\<`void`\>

***

<a id="renew"></a>

### renew()

> **renew**(`lease`, `ttlMs`): `Promise`\<[`Lease`](Lease.md) \| `null`\>

Defined in: [src/core/store/types.ts:326](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L326)

#### Parameters

##### lease

[`Lease`](Lease.md)

##### ttlMs

`number`

#### Returns

`Promise`\<[`Lease`](Lease.md) \| `null`\>
