[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / SAMPLE\_ORDERINGS

# Variable: SAMPLE\_ORDERINGS

> `const` **SAMPLE\_ORDERINGS**: readonly readonly \[`string`, [`OrderingData`](../../type-aliases/OrderingData.md)\][]

Defined in: [src/testing/contracts/operations.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L99)

Plan 7 D7 (F4-R15, F5-R14, the Plan 6 handoff §3): an ordering of each kind the built-in
families record, with each family's own properties. A store must keep every one whole:
a dropped property costs liveness, but a changed one (a `refBlockHash`, a `blockhash`, a
`validFrom` moved later, a bigint narrowed to a number) can prove a transaction absent
while a block holds it, and `rebuild` then pays twice. The bigints exceed 2^53.
