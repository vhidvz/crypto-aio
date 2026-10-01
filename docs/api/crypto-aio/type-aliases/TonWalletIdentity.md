[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TonWalletIdentity

# Type Alias: TonWalletIdentity

> **TonWalletIdentity** = \{ `subwalletId?`: `number`; `version`: `"v4r2"`; `workchain?`: `0` \| `-1`; \} \| \{ `networkGlobalId?`: `number`; `subwalletNumber?`: `number`; `version`: `"v5r1"`; `workchain?`: `0` \| `-1`; \}

Defined in: [src/adapters/ton/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L27)

The wallet contract behind a TON address (spec §9). Every field determines the address,
so it is wallet config (`wallets.<name>.ton`), never a per-call option.
- v4r2: `subwalletId` defaults to `698983191 + workchain`.
- v5r1: `subwalletNumber` defaults to 0 (15 bits); `networkGlobalId` defaults to the
  network's global id (-239 mainnet, -3 testnet) and must equal it.
