[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTransfer

# Interface: DriverTransfer

Defined in: [src/core/driver/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L95)

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/core/driver/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L101)

***

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/driver/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L100)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly `string`[]

Defined in: [src/core/driver/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L98)

***

<a id="locator"></a>

### locator

> `readonly` **locator**: `string`

Defined in: [src/core/driver/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L97)

Deterministic within the transaction, e.g. `native`, `log:3`, `vout:1`, `ix:0.2`.

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/driver/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L103)

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/driver/types.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L102)

***

<a id="to"></a>

### to

> `readonly` **to**: `string`

Defined in: [src/core/driver/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L99)
