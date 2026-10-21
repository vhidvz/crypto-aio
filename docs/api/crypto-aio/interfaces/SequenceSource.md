[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SequenceSource

# Interface: SequenceSource

Defined in: [src/core/driver/types.ts:249](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L249)

## Methods

<a id="latest"></a>

### latest()

> **latest**(`address`): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:253](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L253)

Next nonce/seqno per the latest block.

#### Parameters

##### address

`string`

#### Returns

`Promise`\<`bigint`\>

***

<a id="pending"></a>

### pending()

> **pending**(`address`): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:251](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L251)

Next nonce/seqno including pending transactions.

#### Parameters

##### address

`string`

#### Returns

`Promise`\<`bigint`\>
