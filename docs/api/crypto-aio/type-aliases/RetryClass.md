[crypto-aio](../../index.md) / [crypto-aio](../index.md) / RetryClass

# Type Alias: RetryClass

> **RetryClass** = `"safe"` \| `"ambiguous-on-failure"` \| `"never-auto"`

Defined in: [src/core/transport/types.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L9)

Whether a call may be retried: `safe` (a read, retried and failed over freely),
`ambiguous-on-failure` (a broadcast: retried, and a failure after a request may have
reached the network is marked `ambiguous`), or `never-auto` (one attempt only).
