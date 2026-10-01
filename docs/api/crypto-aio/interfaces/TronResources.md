[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronResources

# Interface: TronResources

Defined in: [src/adapters/tron/types.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L21)

An account's resources (`ext.tron.getResources`), from `getaccountresource`.

## Properties

<a id="activated"></a>

### activated

> `readonly` **activated**: `boolean`

Defined in: [src/adapters/tron/types.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L23)

Whether the account exists on chain (it was activated by a first TRX transfer).

***

<a id="energy"></a>

### energy

> `readonly` **energy**: `bigint`

Defined in: [src/adapters/tron/types.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L29)

Energy left from staked or delegated TRX.

***

<a id="freebandwidth"></a>

### freeBandwidth

> `readonly` **freeBandwidth**: `bigint`

Defined in: [src/adapters/tron/types.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L25)

Free bandwidth left today, in bytes.

***

<a id="stakedbandwidth"></a>

### stakedBandwidth

> `readonly` **stakedBandwidth**: `bigint`

Defined in: [src/adapters/tron/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L27)

Bandwidth left from staked or delegated TRX, in bytes.
