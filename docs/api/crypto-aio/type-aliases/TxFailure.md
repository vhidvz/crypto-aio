[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxFailure

# Type Alias: TxFailure

> **TxFailure** = `"reverted"` \| `"unevidenced"`

Defined in: [src/core/model/transaction.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L46)

What failed in an included transaction: `'reverted'` when its execution failed, so
nothing moved but the fee, and `'unevidenced'` when it executed but the chain shows no
transfer to the recipient (a token that logged none, a jetton sent to a wallet its master
does not name): value may have moved, so check the chain before paying again.
