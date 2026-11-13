[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTxObservation

# Interface: DriverTxObservation

Defined in: [src/core/driver/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L85)

What one read shows of a transaction: nothing yet, a mempool entry, or a block.

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/driver/types.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L90)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/driver/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L89)

***

<a id="failure"></a>

### failure?

> `readonly` `optional` **failure?**: [`TxFailure`](../type-aliases/TxFailure.md)

Defined in: [src/core/driver/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L103)

With `success: false`, what failed (`TxFailure`). Absent is `'reverted'`; a driver sets
`'unevidenced'` when the transaction executed but shows no transfer to the recipient.

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/driver/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L98)

With `success: false`, why, as a short fixed text: no addresses, amounts or node
text, which can carry either. The monitor records it on the observation
(`TxStatus.reason`).

***

<a id="seen"></a>

### seen

> `readonly` **seen**: `"mempool"` \| `"none"` \| `"block"`

Defined in: [src/core/driver/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L86)

***

<a id="success"></a>

### success?

> `readonly` `optional` **success?**: `boolean`

Defined in: [src/core/driver/types.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L92)

For included transactions: false when execution failed or reverted.

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/driver/types.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L88)

The canonical hash the chain reports for the transaction, once seen.
