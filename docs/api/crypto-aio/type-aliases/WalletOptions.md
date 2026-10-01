[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WalletOptions

# Type Alias: WalletOptions

> **WalletOptions** = `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/driver/types.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L28)

Family-specific wallet settings (e.g. `utxo.addressType`, TON wallet identity). The `hd`
key is reserved and core-built: the core sets it to the wallet's `WalletHdOptions` when
the wallet has an `xpub`, and a user's or caller's `hd` never reaches a driver, since a
driver trusts `hd` to validate change addresses.
