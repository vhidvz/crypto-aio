[crypto-aio](../../index.md) / [crypto-aio](../index.md) / deriveXpubChild

# Function: deriveXpubChild()

> **deriveXpubChild**(`xpub`, `relativePath`, `versions?`, `network?`): `Uint8Array`

Defined in: [src/core/signing/hd.ts:179](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/hd.ts#L179)

Non-hardened child public key (33-byte compressed) from an extended PUBLIC key. With
`network`, a key whose SLIP-0132 version belongs to the other network class (a mainnet
`xpub`/`zpub` on a test network, a `tpub`/`vpub` on mainnet) is `CONFIG_INVALID`; a
version outside the Bitcoin SLIP-0132 table has no known class and is not checked. Pass
it for chains whose extended keys carry a network class (UTXO chains).

## Parameters

### xpub

`string`

### relativePath

`string`

### versions?

[`ExtendedKeyVersions`](../interfaces/ExtendedKeyVersions.md)

### network?

#### testnet

`boolean`

## Returns

`Uint8Array`
