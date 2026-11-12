[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AddressCodec

# Interface: AddressCodec

Defined in: [src/core/driver/types.ts:152](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L152)

The chain's address rules: validation, the canonical form, and derivation from a key.

## Properties

<a id="format"></a>

### format?

> `readonly` `optional` **format?**: [`AddressFormatter`](../type-aliases/AddressFormatter.md)

Defined in: [src/core/driver/types.ts:170](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L170)

Formats an address for display, such as a checksummed or user-friendly form.

## Methods

<a id="frompublickey"></a>

### fromPublicKey()

> **fromPublicKey**(`publicKey`, `wallet?`): [`NormalizedAddress`](NormalizedAddress.md)

Defined in: [src/core/driver/types.ts:168](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L168)

The wallet's address for `publicKey`, under the wallet's options (address type, ...).

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

Defined in: [src/core/driver/types.ts:166](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L166)

Throws `ValidationError('INVALID_ADDRESS')`. The returned `variant` is part of the
intent hash: it must hold only JSON scalars (strings, finite numbers, booleans, `null`)
and should contain only semantic fields that change what the transfer does (for example
TON's `bounceable`), never encoding-only choices, so two spellings of one recipient
with the same meaning hash the same.

Its output feeds the intent hash behind idempotency keys and the sequence keys of
nonce state, both of which a store keeps across upgrades: a later version of the
driver returns the same `canonical` and `variant` for the same input.

#### Parameters

##### address

`string`

#### Returns

[`NormalizedAddress`](NormalizedAddress.md)

***

<a id="validate"></a>

### validate()

> **validate**(`address`): `boolean`

Defined in: [src/core/driver/types.ts:154](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L154)

Whether `address` is valid on the network; never throws.

#### Parameters

##### address

`string`

#### Returns

`boolean`
