[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BuildContext

# Interface: BuildContext

Defined in: [src/core/driver/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L37)

## Properties

<a id="decimals"></a>

### decimals?

> `readonly` `optional` **decimals?**: `number`

Defined in: [src/core/driver/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L52)

The decimals the core scaled the intent's amounts with: the asset's registered
metadata, or what the chain gave. Drivers work in base units. One whose transaction
signs the decimals (Solana's `transferChecked`) reads them from the chain and must
refuse a mismatch with this value (`ASSET_RESOLUTION`): the amounts were then scaled
wrong. Absent where no transfer is built (a replacement or a cancel).

***

<a id="excludeinputs"></a>

### excludeInputs?

> `readonly` `optional` **excludeInputs?**: readonly `string`[]

Defined in: [src/core/driver/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L44)

Inputs held by other live Operations of this wallet (`inputs` ordering).

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/driver/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L38)

***

<a id="keys"></a>

### keys

> `readonly` **keys**: readonly [`WalletKey`](WalletKey.md)[]

Defined in: [src/core/driver/types.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L39)

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/driver/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L42)

Allocated by the core for `nonce` and `seqno` ordering.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/driver/types.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L53)

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: [`WalletOptions`](../type-aliases/WalletOptions.md)

Defined in: [src/core/driver/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L40)
