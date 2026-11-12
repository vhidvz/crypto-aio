[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainReader

# Interface: ChainReader

Defined in: [src/core/driver/types.ts:174](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L174)

Reads of chain state; the contract table on `ChainDriver` gives each one's call tags.

## Methods

<a id="getbalance"></a>

### getBalance()

> **getBalance**(`address`, `asset`): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L176)

The balance of `asset` at `address`, in base units.

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

Defined in: [src/core/driver/types.ts:185](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L185)

A block by height or hash, or `null` when there is none.

#### Parameters

##### ref

`string` \| `bigint`

#### Returns

`Promise`\<[`DriverBlock`](DriverBlock.md) \| `null`\>

***

<a id="getblockheight"></a>

### getBlockHeight()

> **getBlockHeight**(): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L178)

The head's height.

#### Returns

`Promise`\<`bigint`\>

***

<a id="getfinalizedheight"></a>

### getFinalizedHeight()

> **getFinalizedHeight**(): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:183](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L183)

Highest block satisfying the network's finality policy: the chain's own finality
where it has one, else the head less the confirmations the network requires.

#### Returns

`Promise`\<`bigint`\>

***

<a id="gettokenmetadata"></a>

### getTokenMetadata()?

> `optional` **getTokenMetadata**(`ref`): `Promise`\<[`AssetMetadata`](AssetMetadata.md)\>

Defined in: [src/core/driver/types.ts:198](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L198)

A token's symbol and decimals, read from the chain (the `tokens` capability).

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

Defined in: [src/core/driver/types.ts:187](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L187)

A transaction by id, decoded, or `null` when the chain does not have it.

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`DriverTransaction`](DriverTransaction.md) \| `null`\>

***

<a id="normalizetokenref"></a>

### normalizeTokenRef()?

> `optional` **normalizeTokenRef**(`ref`): `object`

Defined in: [src/core/driver/types.ts:203](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L203)

Canonicalizes a token contract (e.g. EIP-55); identity for asset ids. Asset ids feed
the intent hash, so a later version of the driver keeps the same canonical form.

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

Defined in: [src/core/driver/types.ts:192](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L192)

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
