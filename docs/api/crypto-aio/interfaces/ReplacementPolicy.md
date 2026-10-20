[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ReplacementPolicy

# Interface: ReplacementPolicy

Defined in: [src/core/driver/types.ts:256](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L256)

## Properties

<a id="cancel"></a>

### cancel

> `readonly` **cancel**: `boolean`

Defined in: [src/core/driver/types.ts:258](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L258)

***

<a id="replace"></a>

### replace

> `readonly` **replace**: `boolean`

Defined in: [src/core/driver/types.ts:257](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L257)

## Methods

<a id="buildcancel"></a>

### buildCancel()?

> `optional` **buildCancel**(`previous`, `ctx`, `fee?`): `Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

Defined in: [src/core/driver/types.ts:270](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L270)

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

Defined in: [src/core/driver/types.ts:259](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L259)

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

Defined in: [src/core/driver/types.ts:281](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L281)

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
