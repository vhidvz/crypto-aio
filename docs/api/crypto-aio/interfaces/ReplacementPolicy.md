[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ReplacementPolicy

# Interface: ReplacementPolicy

Defined in: [src/core/driver/types.ts:240](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L240)

## Properties

<a id="cancel"></a>

### cancel

> `readonly` **cancel**: `boolean`

Defined in: [src/core/driver/types.ts:242](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L242)

***

<a id="replace"></a>

### replace

> `readonly` **replace**: `boolean`

Defined in: [src/core/driver/types.ts:241](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L241)

## Methods

<a id="buildcancel"></a>

### buildCancel()?

> `optional` **buildCancel**(`previous`, `ctx`, `fee?`): `Promise`\<[`UnsignedTx`](UnsignedTx.md)\>

Defined in: [src/core/driver/types.ts:254](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L254)

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

Defined in: [src/core/driver/types.ts:243](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L243)

#### Parameters

##### previous

[`UnsignedTx`](UnsignedTx.md)

##### fee

[`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

##### ctx

[`BuildContext`](BuildContext.md)

#### Returns

`Promise`\<[`UnsignedTx`](UnsignedTx.md)\>
