[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SolanaExt

# Interface: SolanaExt

Defined in: [src/adapters/solana/types.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L30)

`bc.ext.solana`: the Solana family extension (spec §5.5).

## Properties

<a id="solana"></a>

### solana

> `readonly` **solana**: `object`

Defined in: [src/adapters/solana/types.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L31)

#### getTokenAccounts()

> **getTokenAccounts**(`owner`, `mint?`): `Promise`\<readonly [`SolanaTokenAccount`](SolanaTokenAccount.md)[]\>

The owner's classic SPL token accounts, optionally for one mint, at the `confirmed`
commitment. Token-2022 accounts are not listed (Token-2022 is unsupported).

##### Parameters

###### owner

`string`

###### mint?

`string`

##### Returns

`Promise`\<readonly [`SolanaTokenAccount`](SolanaTokenAccount.md)[]\>
