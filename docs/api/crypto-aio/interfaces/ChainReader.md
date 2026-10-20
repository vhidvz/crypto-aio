[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainReader

# Interface: ChainReader

Defined in: [src/core/driver/types.ts:139](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L139)

## Methods

<a id="getbalance"></a>

### getBalance()

> **getBalance**(`address`, `asset`): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:140](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L140)

#### Parameters

##### address

`string`

##### asset

[`AssetRef`](../type-aliases/AssetRef.md)

#### Returns

`Promise`\<`bigint`\>

***

<a id="getblock"></a>

### getBlock()

> **getBlock**(`ref`): `Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

Defined in: [src/core/driver/types.ts:144](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L144)

#### Parameters

##### ref

`string` \| `bigint`

#### Returns

`Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

***

<a id="getblockheight"></a>

### getBlockHeight()

> **getBlockHeight**(): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:141](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L141)

#### Returns

`Promise`\<`bigint`\>

***

<a id="getfinalizedheight"></a>

### getFinalizedHeight()

> **getFinalizedHeight**(): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L143)

Highest block satisfying the network's finality policy.

#### Returns

`Promise`\<`bigint`\>

***

<a id="gettokenmetadata"></a>

### getTokenMetadata()?

> `optional` **getTokenMetadata**(`ref`): `Promise`\<[`AssetMetadata`](AssetMetadata.md)\>

Defined in: [src/core/driver/types.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L155)

#### Parameters

##### ref

###### contract

`string`

###### standard

`string`

#### Returns

`Promise`\<[`AssetMetadata`](AssetMetadata.md)\>

***

<a id="gettransaction"></a>

### getTransaction()

> **getTransaction**(`id`): `Promise`\<[`DriverTransaction`](DriverTransaction.md) \| `null`\>

Defined in: [src/core/driver/types.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L145)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`DriverTransaction`](DriverTransaction.md) \| `null`\>

***

<a id="normalizetokenref"></a>

### normalizeTokenRef()?

> `optional` **normalizeTokenRef**(`ref`): `object`

Defined in: [src/core/driver/types.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L157)

Canonicalizes a token contract (e.g. EIP-55); identity for asset ids.

#### Parameters

##### ref

###### contract

`string`

###### standard

`string`

#### Returns

`object`

##### contract

> `readonly` **contract**: `string`

##### standard

> `readonly` **standard**: `string`

***

<a id="observe"></a>

### observe()

> **observe**(`ref`, `ordering`, `from`): `Promise`\<[`DriverTxObservation`](DriverTxObservation.md)\>

Defined in: [src/core/driver/types.ts:150](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L150)

Current view of an Attempt (uses `purpose: 'monitor'` reads). `ordering` and `from` are
`undefined` for a transaction the library does not manage (a status lookup by id).

#### Parameters

##### ref

[`AttemptRef`](AttemptRef.md)

##### ordering

[`OrderingData`](../type-aliases/OrderingData.md) \| `undefined`

##### from

`string` \| `undefined`

#### Returns

`Promise`\<[`DriverTxObservation`](DriverTxObservation.md)\>
