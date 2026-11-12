[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BroadcastResult

# Type Alias: BroadcastResult

> **BroadcastResult** = \{ `kind`: `"accepted"`; \} \| \{ `kind`: `"already-known"`; \} \| \{ `code`: [`CodesOf`](CodesOf.md)\<`"chain"`\>; `kind`: `"refused"`; `reason`: `string`; \} \| \{ `kind`: `"rejected"`; `reason`: `string`; \}

Defined in: [src/core/driver/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L78)

`refused`: state-dependent (may become valid, or may already be included) — observed only.
`rejected`: permanently invalid by construction (malformed, bad signature, wrong chain).
The core records one endpoint's `rejected` as proven evidence and fails the Operation
with `TX_REJECTED`, after which a caller may pay again, so a driver returns it only once
it has checked that the reason holds for its own bytes; anything less certain is
`refused`.
