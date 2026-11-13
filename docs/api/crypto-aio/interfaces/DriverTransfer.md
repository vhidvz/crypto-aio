[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTransfer

# Interface: DriverTransfer

Defined in: [src/core/driver/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L107)

One movement of value a transaction makes, in base units.

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/core/driver/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L119)

***

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/driver/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L118)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly `string`[]

Defined in: [src/core/driver/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L116)

The senders, as the driver's `normalize` returns them.

***

<a id="locator"></a>

### locator

> `readonly` **locator**: `string`

Defined in: [src/core/driver/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L114)

Deterministic within the transaction, e.g. `native`, `log:3`, `vout:1`, `ix:0.2`. A
deposit's id is `${txId}:${locator}`, which callers credit once by, so a driver gives a
transfer the same locator from the scanner, `getTransaction` and `history`, from every
provider, and in every later version of the driver.

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/driver/types.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L122)

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/driver/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L121)

Where the transfer was read from, such as the native value or a token event.

***

<a id="to"></a>

### to

> `readonly` **to**: `string`

Defined in: [src/core/driver/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L117)
