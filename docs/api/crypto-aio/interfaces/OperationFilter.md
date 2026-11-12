[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationFilter

# Interface: OperationFilter

Defined in: [src/core/store/types.ts:279](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L279)

Which Operations `list` and `purge` match: every given field must match.

## Properties

<a id="chain"></a>

### chain?

> `readonly` `optional` **chain?**: `string`

Defined in: [src/core/store/types.ts:282](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L282)

`context.chain`.

***

<a id="from"></a>

### from?

> `readonly` `optional` **from?**: `string`

Defined in: [src/core/store/types.ts:286](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L286)

`intent.from`, the sending address.

***

<a id="limit"></a>

### limit?

> `readonly` `optional` **limit?**: `number`

Defined in: [src/core/store/types.ts:289](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L289)

At most this many, the oldest first; 0 or less matches none.

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/store/types.ts:280](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L280)

***

<a id="network"></a>

### network?

> `readonly` `optional` **network?**: `string`

Defined in: [src/core/store/types.ts:284](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L284)

`context.network`.

***

<a id="states"></a>

### states?

> `readonly` `optional` **states?**: readonly [`OperationState`](../type-aliases/OperationState.md)[]

Defined in: [src/core/store/types.ts:287](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L287)
