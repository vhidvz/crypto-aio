[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TonFeeDetails

# Interface: TonFeeDetails

Defined in: [src/adapters/ton/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L55)

`FeeEstimate.details` of the `ton` fee kind, in nanograms. The `network` charge is
`importFee + gasFee + storageFee + forwardFee`; a jetton transfer adds an `attached`
charge (`attached` per output), whose unspent part the jetton wallet refunds.

## Properties

<a id="attached"></a>

### attached?

> `readonly` `optional` **attached?**: `bigint`

Defined in: [src/adapters/ton/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L69)

Jetton transfers: the value attached to each jetton wallet message.

***

<a id="deploy"></a>

### deploy

> `readonly` **deploy**: `boolean`

Defined in: [src/adapters/ton/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L73)

Whether the message deploys the wallet (its first send carries the `StateInit`).

***

<a id="forwardamount"></a>

### forwardAmount?

> `readonly` `optional` **forwardAmount?**: `bigint`

Defined in: [src/adapters/ton/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L71)

Jetton transfers: `forward_ton_amount`, which pays for the recipient's notification.

***

<a id="forwardfee"></a>

### forwardFee

> `readonly` **forwardFee**: `bigint`

Defined in: [src/adapters/ton/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L62)

The forward fees of every outgoing internal message (full `fwd_fee`), counted once.

***

<a id="forwardfeesource"></a>

### forwardFeeSource

> `readonly` **forwardFeeSource**: `"emulated"` \| `"computed"`

Defined in: [src/adapters/ton/types.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L67)

Where `forwardFee` comes from: the endpoint's emulation (`fwd_fee`, which follows
the real action list), or, when it reports none, config params 24/25.

***

<a id="gasfee"></a>

### gasFee

> `readonly` **gasFee**: `bigint`

Defined in: [src/adapters/ton/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L59)

The wallet's compute phase, from the endpoint's emulation.

***

<a id="importfee"></a>

### importFee

> `readonly` **importFee**: `bigint`

Defined in: [src/adapters/ton/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L57)

The inbound external message's import fee.

***

<a id="storagefee"></a>

### storageFee

> `readonly` **storageFee**: `bigint`

Defined in: [src/adapters/ton/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L60)
