[crypto-aio](../../index.md) / [crypto-aio](../index.md) / RequestPurpose

# Type Alias: RequestPurpose

> **RequestPurpose** = `"read"` \| `"monitor"` \| `"proof"` \| `"broadcast"`

Defined in: [src/core/transport/types.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L14)

What a call is for: `read` (any usable endpoint), `monitor` and `proof` (only endpoints
that are not lagging; `proof` reads under the proof quorum's rules), or `broadcast`.
