[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheFeeOverride

# Type Alias: AvalancheFeeOverride

> **AvalancheFeeOverride** = `object`

Defined in: [src/adapters/avalanche/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L52)

An explicit P-Chain fee (`TransferIntent.fee`): the gas price in nAVAX per unit of gas,
as a bigint or a decimal integer string. The X-Chain's fee is fixed, so it takes the
speeds only.

## Properties

<a id="gasprice"></a>

### gasPrice

> `readonly` **gasPrice**: `bigint` \| `string`

Defined in: [src/adapters/avalanche/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L52)
