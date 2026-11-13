[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointState

# Type Alias: EndpointState

> **EndpointState** = `"healthy"` \| `"lagging"` \| `"open"` \| `"half-open"` \| `"disabled"` \| `"unknown"`

Defined in: [src/core/transport/types.ts:169](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L169)

An endpoint's health: `healthy`; `lagging` (behind by more than `maxLagBlocks`); `open`
or `half-open` (its circuit breaker rests it, or is trying it again); `disabled` (it
serves another network); `unknown` (not probed yet, or its height not known yet).
