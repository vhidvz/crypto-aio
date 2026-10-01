[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / AVALANCHE\_CAPABILITIES

# Variable: AVALANCHE\_CAPABILITIES

> `const` **AVALANCHE\_CAPABILITIES**: readonly [`Capability`](../../type-aliases/Capability.md)[]

Defined in: [src/adapters/avalanche/network.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/network.ts#L18)

Every capability of an Avalanche network. The Data API indexer is required (spec §15's
shape for UTXO chains): it locates a transaction's block and serves address history.
