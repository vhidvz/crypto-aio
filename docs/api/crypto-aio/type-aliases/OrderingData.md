[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OrderingData

# Type Alias: OrderingData

> **OrderingData** = \{ `kind`: `"nonce"`; `nonce`: `bigint`; \} \| \{ `kind`: `"seqno"`; `seqno`: `bigint`; `validUntil`: `number`; \} \| \{ `inputs`: readonly `string`[]; `kind`: `"inputs"`; \} \| \{ `expiresAtMs?`: `number`; `kind`: `"expiry"`; `lastValidHeight?`: `bigint`; \}

Defined in: [src/core/model/ordering.ts:3](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ordering.ts#L3)
