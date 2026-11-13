[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptPurpose

# Type Alias: AttemptPurpose

> **AttemptPurpose** = `"original"` \| `"replacement"` \| `"cancel"` \| `"rebuild"`

Defined in: [src/core/store/types.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L90)

Why an Attempt was signed: the first transaction of its Operation, a fee replacement, a
cancel (a transaction to the sender in the same slot) or a rebuild after an expiry.
