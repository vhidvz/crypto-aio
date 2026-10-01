[crypto-aio](../../../index.md) / [crypto-aio/ton](../index.md) / TON\_PEER\_DEPENDENCIES

# Variable: TON\_PEER\_DEPENDENCIES

> `const` **TON\_PEER\_DEPENDENCIES**: `Readonly`\<`Record`\<`"@ton/ton"` \| `"@ton/core"` \| `"@ton/crypto"`, [`PeerDependency`](../../interfaces/PeerDependency.md)\>\>

Defined in: [src/adapters/ton/plugin.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/plugin.ts#L23)

The SDK versions this adapter is validated against, keyed by package name. The one
`@ton/ton` library needs all three: `@ton/ton` and `@ton/core` both declare
`@ton/crypto` as a peer, and `@ton/core` requires it at load time.
