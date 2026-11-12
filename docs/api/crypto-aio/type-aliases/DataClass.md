[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DataClass

# Type Alias: DataClass

> **DataClass** = `"secret"` \| `"sensitive"` \| `"sensitive-until-broadcast"` \| `"operational"`

Defined in: [src/core/store/types.ts:537](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L537)

How sensitive a stored field is, so a store can encrypt and retain each field as
`DATA_CLASSIFICATION` says: encrypt `sensitive` fields at rest; `sensitive-until-broadcast`
ones are public once the transaction is sent; `operational` ones are safe for
telemetry. No stored field is `secret`.
