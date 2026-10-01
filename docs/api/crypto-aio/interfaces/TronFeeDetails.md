[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronFeeDetails

# Interface: TronFeeDetails

Defined in: [src/adapters/tron/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L44)

`FeeEstimate.details` of the `tron` fee kind. Sun (1 TRX = 10^6 sun), bytes and energy
units. The charges are upper bounds for the account's resources at estimate time.

## Properties

<a id="activation"></a>

### activation

> `readonly` **activation**: `boolean`

Defined in: [src/adapters/tron/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L59)

A TRX transfer to an address that is not activated yet pays account creation.

***

<a id="bandwidth"></a>

### bandwidth

> `readonly` **bandwidth**: `bigint`

Defined in: [src/adapters/tron/types.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L46)

Bandwidth the signed transaction consumes, in bytes (its size plus 64).

***

<a id="bandwidthprice"></a>

### bandwidthPrice

> `readonly` **bandwidthPrice**: `bigint`

Defined in: [src/adapters/tron/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L48)

The chain's price of one byte of bandwidth, in sun (`getTransactionFee`).

***

<a id="energy"></a>

### energy?

> `readonly` `optional` **energy?**: `bigint`

Defined in: [src/adapters/tron/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L50)

TRC-20 only: the simulated energy plus the safety margin.

***

<a id="energyprice"></a>

### energyPrice?

> `readonly` `optional` **energyPrice?**: `bigint`

Defined in: [src/adapters/tron/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L52)

TRC-20 only: the chain's price of one energy unit, in sun (`getEnergyFee`).

***

<a id="feelimit"></a>

### feeLimit?

> `readonly` `optional` **feeLimit?**: `bigint`

Defined in: [src/adapters/tron/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L57)

TRC-20 only: `raw_data.fee_limit`, which caps the energy the call may use:
min(energy × price, the network's maximum, the handle's `maxFeeLimit`).
