[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTransfer

# Interface: DriverTransfer

Defined in: [src/core/driver/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L79)

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/core/driver/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L85)

***

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/driver/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L84)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly `string`[]

Defined in: [src/core/driver/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L82)

***

<a id="locator"></a>

### locator

> `readonly` **locator**: `string`

Defined in: [src/core/driver/types.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L81)

Deterministic within the transaction, e.g. `native`, `log:3`, `vout:1`, `ix:0.2`.

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/driver/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L87)

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/driver/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L86)

***

<a id="to"></a>

### to

> `readonly` **to**: `string`

Defined in: [src/core/driver/types.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L83)
