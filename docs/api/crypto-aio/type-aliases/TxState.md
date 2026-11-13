[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxState

# Type Alias: TxState

> **TxState** = `"unknown"` \| `"pending"` \| `"mempool"` \| `"included"` \| `"final"` \| `"failed"` \| `"dropped"` \| `"replaced"` \| `"expired"` \| `"refused"` \| `"rejected"`

Defined in: [src/core/model/transaction.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L34)

What the chain shows of a transaction: `unknown`, `pending` (sent or signed, not seen yet), `mempool`,
`included`, `final`, `failed`, `dropped` (no longer seen), `replaced` (another
transaction took its slot), `expired`, `refused` (a node refused it for now) or
`rejected` (never valid). `dropped` and `refused` are never terminal.
