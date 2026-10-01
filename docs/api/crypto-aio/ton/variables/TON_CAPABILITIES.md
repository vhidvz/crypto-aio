[crypto-aio](../../../index.md) / [crypto-aio/ton](../index.md) / TON\_CAPABILITIES

# Variable: TON\_CAPABILITIES

> `const` **TON\_CAPABILITIES**: readonly [`Capability`](../../type-aliases/Capability.md)[]

Defined in: [src/adapters/ton/network.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/network.ts#L18)

The TON manifest's capabilities (spec §15); `address-history` comes with the indexer. No
`batch-transfer` (Task 9): the verdict answers `failed` for a partly delivered batch, and
a failed Operation sent again whole would pay twice the outputs that moved, so a TON
transfer carries exactly one output.
