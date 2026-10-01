[crypto-aio](../../../index.md) / [crypto-aio/ton](../index.md) / TON\_PEER\_DEPENDENCIES

# Variable: TON\_PEER\_DEPENDENCIES

> `const` **TON\_PEER\_DEPENDENCIES**: `Readonly`\<`Record`\<`"@ton/ton"` \| `"@ton/core"` \| `"@ton/crypto"`, [`PeerDependency`](../../interfaces/PeerDependency.md)\>\>

Defined in: [src/adapters/ton/plugin.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/plugin.ts#L22)

The SDK versions this adapter is validated against (spec §16, D2), keyed by package name
(Plan 2's final family shape). The one `@ton/ton` library needs all three.
