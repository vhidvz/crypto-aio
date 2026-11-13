[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationState

# Type Alias: OperationState

> **OperationState** = `"created"` \| `"prepared"` \| `"awaiting-signature"` \| `"signed"` \| `"submitted"` \| `"stalled"` \| `"included"` \| `"final"` \| `"failed"` \| `"expired"` \| `"abandoned"`

Defined in: [src/core/store/types.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L20)

Where an Operation is in its lifecycle. `TERMINAL_STATES` end it and are fixed through
1.x; a minor release may add only non-terminal states, so a store may name the terminal
ones in a query or an index.
