[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OrderingKind

# Type Alias: OrderingKind

> **OrderingKind** = `"nonce"` \| `"seqno"` \| `"inputs"` \| `"expiry"`

Defined in: [src/core/model/ordering.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ordering.ts#L6)

How a chain orders an address's transactions: an account `nonce` (EVM), a wallet
`seqno` (TON), the `inputs` a transaction spends (Bitcoin, Avalanche), or an `expiry`
after which it can never land (Tron, Solana).
