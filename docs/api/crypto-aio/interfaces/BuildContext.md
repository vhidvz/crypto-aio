[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BuildContext

# Interface: BuildContext

Defined in: [src/core/driver/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L40)

What a build needs besides the intent: the sender, its keys and its wallet options.

## Properties

<a id="decimals"></a>

### decimals?

> `readonly` `optional` **decimals?**: `number`

Defined in: [src/core/driver/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L56)

The decimals the core scaled the intent's amounts with: the asset's registered
metadata, or what the chain gave. Drivers work in base units. One whose transaction
signs the decimals (Solana's `transferChecked`) reads them from the chain and must
refuse a mismatch with this value (`ASSET_RESOLUTION`): the amounts were then scaled
wrong. Absent where no transfer is built (a replacement or a cancel).

***

<a id="excludeinputs"></a>

### excludeInputs?

> `readonly` `optional` **excludeInputs?**: readonly `string`[]

Defined in: [src/core/driver/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L48)

Inputs held by other live Operations of this wallet (`inputs` ordering).

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/driver/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L42)

The sending address, as the driver's `normalize` returned it.

***

<a id="keys"></a>

### keys

> `readonly` **keys**: readonly [`WalletKey`](WalletKey.md)[]

Defined in: [src/core/driver/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L43)

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/driver/types.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L46)

Allocated by the core for `nonce` and `seqno` ordering.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/driver/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L57)

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: [`WalletOptions`](../type-aliases/WalletOptions.md)

Defined in: [src/core/driver/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L44)
