[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DATA\_CLASSIFICATION

# Variable: DATA\_CLASSIFICATION

> `const` **DATA\_CLASSIFICATION**: `object`

Defined in: [src/core/store/types.ts:374](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L374)

Field classification so backing stores can apply encryption and retention per field.

`operation.reservation` and `attempt.ordering` are `sensitive` because an `inputs`
ordering lists UTXO outpoints, which tie a wallet to its coins. A nonce or seqno value
on its own is an operational identifier, like an Operation id: the `nonce.allocated`
and `nonce.gap` events carry it, and logs may too.

## Type Declaration

<a id="attempt"></a>

### attempt

> `readonly` **attempt**: `Readonly`\<`Record`\<keyof [`AttemptRecord`](../interfaces/AttemptRecord.md), [`DataClass`](../type-aliases/DataClass.md)\>\>

<a id="observation"></a>

### observation

> `readonly` **observation**: `Readonly`\<`Record`\<keyof [`AttemptObservation`](../interfaces/AttemptObservation.md), [`DataClass`](../type-aliases/DataClass.md)\>\>

<a id="operation"></a>

### operation

> `readonly` **operation**: `Readonly`\<`Record`\<keyof [`OperationRecord`](../interfaces/OperationRecord.md), [`DataClass`](../type-aliases/DataClass.md)\>\>
