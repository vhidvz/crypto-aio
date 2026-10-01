[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTxObservation

# Interface: DriverTxObservation

Defined in: [src/core/driver/types.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L65)

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/driver/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L69)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/driver/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L68)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/driver/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L76)

P6-2: with `success: false`, why, as a short fixed text (R24: no addresses, amounts or
node text). The monitor records it on the observation (`TxStatus.reason`).

***

<a id="seen"></a>

### seen

> `readonly` **seen**: `"mempool"` \| `"none"` \| `"block"`

Defined in: [src/core/driver/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L66)

***

<a id="success"></a>

### success?

> `readonly` `optional` **success?**: `boolean`

Defined in: [src/core/driver/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L71)

For included transactions: false when execution failed or reverted.

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/driver/types.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L67)
