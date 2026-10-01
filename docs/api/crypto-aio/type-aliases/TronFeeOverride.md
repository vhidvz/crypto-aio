[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronFeeOverride

# Type Alias: TronFeeOverride

> **TronFeeOverride** = `object`

Defined in: [src/adapters/tron/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L68)

An explicit Tron fee (`TransferIntent.fee`): TRC-20 transfers only. `feeLimit` (sun)
replaces the estimated fee limit; it may not be lower than the estimated energy cost,
because a lower cap makes the transaction fail on chain (`OUT_OF_ENERGY`) and still pay,
nor higher than the network's maximum or the handle's `maxFeeLimit` option.

## Properties

<a id="feelimit"></a>

### feeLimit

> `readonly` **feeLimit**: `bigint`

Defined in: [src/adapters/tron/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L68)
