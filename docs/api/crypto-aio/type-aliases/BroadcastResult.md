[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BroadcastResult

# Type Alias: BroadcastResult

> **BroadcastResult** = \{ `kind`: `"accepted"`; \} \| \{ `kind`: `"already-known"`; \} \| \{ `code`: [`CodesOf`](CodesOf.md)\<`"chain"`\>; `kind`: `"refused"`; `reason`: `string`; \} \| \{ `kind`: `"rejected"`; `reason`: `string`; \}

Defined in: [src/core/driver/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L59)

`refused`: state-dependent (may become valid, or may already be included) — observed only.
`rejected`: permanently invalid by construction (malformed, bad signature, wrong chain).
