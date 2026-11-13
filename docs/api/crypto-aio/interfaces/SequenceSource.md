[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SequenceSource

# Interface: SequenceSource

Defined in: [src/core/driver/types.ts:315](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L315)

The chain's view of an address's next nonce or seqno (`nonce` and `seqno` ordering).

## Methods

<a id="latest"></a>

### latest()

> **latest**(`address`): `Promise`\<`bigint`\>

Defined in: [src/core/driver/types.ts:319](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L319)

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

Defined in: [src/core/driver/types.ts:317](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L317)

Next nonce/seqno including pending transactions.

#### Parameters

##### address

`string`

#### Returns

`Promise`\<`bigint`\>
