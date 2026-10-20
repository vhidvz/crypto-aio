[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OrderingData

# Type Alias: OrderingData

> **OrderingData** = \{ `kind`: `"nonce"`; `nonce`: `bigint`; \} \| \{ `kind`: `"seqno"`; `seqno`: `bigint`; `validUntil`: `number`; \} \| \{ `inputs`: readonly `string`[]; `kind`: `"inputs"`; \} \| \{ `expiresAtMs?`: `number`; `kind`: `"expiry"`; `lastValidHeight?`: `bigint`; \}

Defined in: [src/core/model/ordering.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ordering.ts#L11)

What reserves an Attempt's slot. A family's build may record more about a `seqno` or
`expiry` slot in the same object (TON's `validFrom`, Tron's `refBlockHash`, Solana's
`blockhash` and `blockhashSlot`, each in the family's own exported type), and its proofs
read those fields back. A store keeps every ordering whole and unchanged, extra fields
included: strings, finite numbers and bigints beyond 2^53. The `OperationStore` contract
suite checks each built-in family's (`SAMPLE_ORDERINGS`).
