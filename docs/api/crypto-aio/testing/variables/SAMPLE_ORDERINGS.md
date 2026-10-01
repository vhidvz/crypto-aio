[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / SAMPLE\_ORDERINGS

# Variable: SAMPLE\_ORDERINGS

> `const` **SAMPLE\_ORDERINGS**: readonly readonly \[`string`, [`OrderingData`](../../type-aliases/OrderingData.md)\][]

Defined in: [src/testing/contracts/operations.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L101)

An ordering of each kind the built-in families record, with each family's own
properties. Proofs read these facts from the stored ordering, never from signed bytes,
so a store must keep every one whole: a dropped property costs liveness, but a changed
one (a `refBlockHash`, a `blockhash`, a `validFrom` moved later, a bigint narrowed to a
number) can prove a transaction absent while a block holds it, and `rebuild` then pays
twice. The bigints exceed 2^53. The core's `OrderingData` does not name these fields:
each family exports its typed ordering, and this contract pins that a store keeps them.
