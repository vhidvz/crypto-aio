[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NormalizedAddress

# Interface: NormalizedAddress

Defined in: [src/core/model/address.ts:2](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L2)

An address as a chain's codec normalizes it.

## Properties

<a id="canonical"></a>

### canonical

> `readonly` **canonical**: `string`

Defined in: [src/core/model/address.ts:4](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L4)

The one form that identifies the address: equality and stored records use it.

***

<a id="display"></a>

### display

> `readonly` **display**: `string`

Defined in: [src/core/model/address.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L6)

The form to show, such as a checksummed or user-friendly spelling.

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/address.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L15)

Chain-specific meaning of a recipient address. It reaches drivers in
`DriverOutput.variant` and is part of the intent hash, so it must hold only JSON scalars
(strings, finite numbers, booleans, `null`) under string keys, and should contain only
semantic fields that change what the transfer does (for example TON's `bounceable`),
never encoding-only choices such as a display alphabet. Omit it, or leave it empty,
when the address has no such meaning: an empty variant is no variant.
