[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTxObservation

# Interface: DriverTxObservation

Defined in: [src/core/driver/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L75)

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/driver/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L79)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/driver/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L78)

***

<a id="failure"></a>

### failure?

> `readonly` `optional` **failure?**: [`TxFailure`](../type-aliases/TxFailure.md)

Defined in: [src/core/driver/types.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L92)

With `success: false`, what failed (`TxFailure`). Absent is `'reverted'`; a driver sets
`'unevidenced'` when the transaction executed but shows no transfer to the recipient.

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/driver/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L87)

With `success: false`, why, as a short fixed text: no addresses, amounts or node
text, which can carry either. The monitor records it on the observation
(`TxStatus.reason`).

***

<a id="seen"></a>

### seen

> `readonly` **seen**: `"mempool"` \| `"none"` \| `"block"`

Defined in: [src/core/driver/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L76)

***

<a id="success"></a>

### success?

> `readonly` `optional` **success?**: `boolean`

Defined in: [src/core/driver/types.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L81)

For included transactions: false when execution failed or reverted.

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/driver/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L77)
