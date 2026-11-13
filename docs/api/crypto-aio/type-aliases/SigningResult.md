[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SigningResult

# Type Alias: SigningResult

> **SigningResult** = \{ `signatures`: readonly [`SignatureBundle`](../interfaces/SignatureBundle.md)[]; `status`: `"signed"`; \} \| \{ `status`: `"pending"`; `ticket?`: `string`; \}

Defined in: [src/core/signing/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L48)

A signer's answer: the signatures, or `pending` with a ticket to collect them later.
