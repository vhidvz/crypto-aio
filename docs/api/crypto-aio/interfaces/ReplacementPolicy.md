[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ReplacementPolicy

# Interface: ReplacementPolicy

Defined in: [src/core/driver/types.ts:323](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L323)

Whether and how an Attempt's slot can be taken by another transaction.

## Properties

<a id="cancel"></a>

### cancel

> `readonly` **cancel**: `boolean`

Defined in: [src/core/driver/types.ts:327](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L327)

Whether a pending transfer can be cancelled (`cancel`).

***

<a id="replace"></a>

### replace

> `readonly` **replace**: `boolean`

Defined in: [src/core/driver/types.ts:325](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L325)

Whether a pending transfer can be replaced at a higher fee (`replace-fee`).

## Methods

<a id="buildcancel"></a>

### buildCancel()?

> `optional` **buildCancel**(`previous`, `ctx`, `fee?`): `Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

Defined in: [src/core/driver/types.ts:340](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L340)

A transaction for `previous`'s slot that does not execute the transfer (e.g. a
self-transfer). Without `fee` it pays the network's minimum bump over `previous`; with
one, that fee, refused (FEE_TOO_LOW) below the bump. `previous` may itself be a cancel
(a repeat cancel bumps a stuck one).

#### Parameters

##### previous

[`UnsignedTx`](UnsignedTx.md)

##### ctx

[`BuildContext`](BuildContext.md)

##### fee?

[`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

***

<a id="buildreplacement"></a>

### buildReplacement()?

> `optional` **buildReplacement**(`previous`, `fee`, `ctx`): `Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

Defined in: [src/core/driver/types.ts:329](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L329)

`previous`'s transfer again, in its slot, at `fee`; `FEE_TOO_LOW` below the bump.

#### Parameters

##### previous

[`UnsignedTx`](UnsignedTx.md)

##### fee

[`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

##### ctx

[`BuildContext`](BuildContext.md)

#### Returns

`Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

***

<a id="compareprice"></a>

### comparePrice()?

> `optional` **comparePrice**(`a`, `b`): `number`

Defined in: [src/core/driver/types.ts:351](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L351)

Orders two transactions of one slot by the price a node compares when one replaces
the other: negative when `a` pays less, positive when it pays more, `0` when neither
does. A repeat cancel bumps from the highest earlier cancel by this order; without it,
the core compares their total charges, which a gas limit can skew.

#### Parameters

##### a

[`UnsignedTx`](UnsignedTx.md)

##### b

[`UnsignedTx`](UnsignedTx.md)

#### Returns

`number`
