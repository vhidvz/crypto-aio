[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AddressCodec

# Interface: AddressCodec

Defined in: [src/core/driver/types.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L109)

## Properties

<a id="format"></a>

### format?

> `readonly` `optional` **format?**: [`AddressFormatter`](../type-aliases/AddressFormatter.md)

Defined in: [src/core/driver/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L120)

## Methods

<a id="frompublickey"></a>

### fromPublicKey()

> **fromPublicKey**(`publicKey`, `wallet?`): [`NormalizedAddress`](NormalizedAddress.md)

Defined in: [src/core/driver/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L119)

#### Parameters

##### publicKey

`Uint8Array`

##### wallet?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

[`NormalizedAddress`](NormalizedAddress.md)

***

<a id="normalize"></a>

### normalize()

> **normalize**(`address`): [`NormalizedAddress`](NormalizedAddress.md)

Defined in: [src/core/driver/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L118)

Throws `ValidationError('INVALID_ADDRESS')`. The returned `variant` is part of the
intent hash: it must hold only JSON scalars (strings, finite numbers, booleans, `null`)
and should contain only semantic fields that change what the transfer does (for example
TON's `bounceable`), never encoding-only choices, so two spellings of one recipient
with the same meaning hash the same.

#### Parameters

##### address

`string`

#### Returns

[`NormalizedAddress`](NormalizedAddress.md)

***

<a id="validate"></a>

### validate()

> **validate**(`address`): `boolean`

Defined in: [src/core/driver/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L110)

#### Parameters

##### address

`string`

#### Returns

`boolean`
