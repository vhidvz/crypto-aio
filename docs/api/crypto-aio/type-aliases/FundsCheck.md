[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FundsCheck

# Type Alias: FundsCheck

> **FundsCheck** = \{ `ok`: `true`; \} \| \{ `asset`: [`AssetRef`](AssetRef.md); `available`: `bigint`; `ok`: `false`; `required`: `bigint`; \}

Defined in: [src/core/driver/types.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L61)

Whether the sender holds what the transfer and its fee need; when not, the shortfall.
