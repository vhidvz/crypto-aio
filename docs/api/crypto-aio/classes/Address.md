[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Address

# Class: Address

Defined in: [src/core/model/address.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L21)

A chain-bound address. Equality uses `canonical`; `variant` keeps chain-specific meaning.

## Implements

- [`NormalizedAddress`](../interfaces/NormalizedAddress.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new Address**(`chain`, `normalized`, `format?`): `Address`

Defined in: [src/core/model/address.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L28)

#### Parameters

##### chain

`string`

##### normalized

[`NormalizedAddress`](../interfaces/NormalizedAddress.md)

##### format?

[`AddressFormatter`](../type-aliases/AddressFormatter.md)

#### Returns

`Address`

## Properties

<a id="canonical"></a>

### canonical

> `readonly` **canonical**: `string`

Defined in: [src/core/model/address.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L23)

#### Implementation of

[`NormalizedAddress`](../interfaces/NormalizedAddress.md).[`canonical`](../interfaces/NormalizedAddress.md#canonical)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/model/address.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L22)

***

<a id="display"></a>

### display

> `readonly` **display**: `string`

Defined in: [src/core/model/address.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L24)

#### Implementation of

[`NormalizedAddress`](../interfaces/NormalizedAddress.md).[`display`](../interfaces/NormalizedAddress.md#display)

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/address.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L25)

Chain-specific meaning of a recipient address. It reaches drivers in
`DriverOutput.variant` and is part of the intent hash, so it must hold only JSON scalars
(strings, finite numbers, booleans, `null`) under string keys, and should contain only
semantic fields that change what the transfer does (for example TON's `bounceable`),
never encoding-only choices such as a display alphabet. Omit it, or leave it empty,
when the address has no such meaning: an empty variant is no variant.

#### Implementation of

[`NormalizedAddress`](../interfaces/NormalizedAddress.md).[`variant`](../interfaces/NormalizedAddress.md#variant)

## Methods

<a id="equals"></a>

### equals()

> **equals**(`other`): `boolean`

Defined in: [src/core/model/address.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L41)

#### Parameters

##### other

`string` \| [`NormalizedAddress`](../interfaces/NormalizedAddress.md) \| `Address`

#### Returns

`boolean`

***

<a id="format"></a>

### format()

> **format**(`options?`): `string`

Defined in: [src/core/model/address.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L37)

#### Parameters

##### options?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`string`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `object`

Defined in: [src/core/model/address.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L51)

#### Returns

`object`

##### canonical

> **canonical**: `string`

##### chain

> **chain**: `string`

##### display

> **display**: `string`

##### variant?

> `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

***

<a id="tostring"></a>

### toString()

> **toString**(): `string`

Defined in: [src/core/model/address.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L47)

Returns a string representation of an object.

#### Returns

`string`
