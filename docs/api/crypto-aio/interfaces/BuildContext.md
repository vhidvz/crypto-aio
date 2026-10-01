[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BuildContext

# Interface: BuildContext

Defined in: [src/core/driver/types.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L35)

## Properties

<a id="excludeinputs"></a>

### excludeInputs?

> `readonly` `optional` **excludeInputs?**: readonly `string`[]

Defined in: [src/core/driver/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L42)

Inputs held by other live Operations of this wallet (`inputs` ordering).

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/core/driver/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L36)

***

<a id="keys"></a>

### keys

> `readonly` **keys**: readonly [`WalletKey`](WalletKey.md)[]

Defined in: [src/core/driver/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L37)

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/driver/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L40)

Allocated by the core for `nonce` and `seqno` ordering.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/driver/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L43)

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: [`WalletOptions`](../type-aliases/WalletOptions.md)

Defined in: [src/core/driver/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L38)
