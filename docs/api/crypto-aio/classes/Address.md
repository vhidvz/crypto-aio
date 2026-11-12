[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Address

# Class: Address

Defined in: [src/core/model/address.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L25)

A chain-bound address. Equality uses `canonical`; `variant` keeps chain-specific meaning.

## Implements

- [`NormalizedAddress`](../interfaces/NormalizedAddress.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new Address**(`chain`, `normalized`, `format?`): `Address`

Defined in: [src/core/model/address.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L32)

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

Defined in: [src/core/model/address.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L27)

The one form that identifies the address: equality and stored records use it.

#### Implementation of

[`NormalizedAddress`](../interfaces/NormalizedAddress.md).[`canonical`](../interfaces/NormalizedAddress.md#canonical)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/model/address.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L26)

***

<a id="display"></a>

### display

> `readonly` **display**: `string`

Defined in: [src/core/model/address.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L28)

The form to show, such as a checksummed or user-friendly spelling.

#### Implementation of

[`NormalizedAddress`](../interfaces/NormalizedAddress.md).[`display`](../interfaces/NormalizedAddress.md#display)

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/address.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L29)

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

Defined in: [src/core/model/address.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L45)

#### Parameters

##### other

`string` \| [`NormalizedAddress`](../interfaces/NormalizedAddress.md) \| `Address`

#### Returns

`boolean`

***

<a id="format"></a>

### format()

> **format**(`options?`): `string`

Defined in: [src/core/model/address.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L41)

#### Parameters

##### options?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`string`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `object`

Defined in: [src/core/model/address.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L55)

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

Defined in: [src/core/model/address.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L51)

Returns a string representation of an object.

#### Returns

`string`
