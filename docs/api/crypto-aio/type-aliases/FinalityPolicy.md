[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FinalityPolicy

# Type Alias: FinalityPolicy

> **FinalityPolicy** = \{ `confirmations`: `number`; `kind`: `"confirmations"`; \} \| \{ `fallbackConfirmations`: `number`; `kind`: `"tag"`; `tag`: `"finalized"`; \} \| \{ `kind`: `"solidified"`; \} \| \{ `kind`: `"commitment"`; `level`: `"finalized"`; \} \| \{ `kind`: `"masterchain"`; \}

Defined in: [src/core/model/chain.ts:4](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/chain.ts#L4)
