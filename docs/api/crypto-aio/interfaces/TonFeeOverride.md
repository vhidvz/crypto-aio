[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TonFeeOverride

# Interface: TonFeeOverride

Defined in: [src/adapters/ton/types.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L81)

An explicit TON fee (`TransferIntent.fee`). TON fees are fixed by the network config, so
there is nothing to bid; a jetton transfer may change the value attached to each jetton
wallet message (default: the network's `jettonAttached`).

## Properties

<a id="attached"></a>

### attached?

> `readonly` `optional` **attached?**: `bigint`

Defined in: [src/adapters/ton/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L82)
