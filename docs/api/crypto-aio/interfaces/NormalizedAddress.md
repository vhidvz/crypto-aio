[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NormalizedAddress

# Interface: NormalizedAddress

Defined in: [src/core/model/address.ts:1](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L1)

## Properties

<a id="canonical"></a>

### canonical

> `readonly` **canonical**: `string`

Defined in: [src/core/model/address.ts:2](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L2)

***

<a id="display"></a>

### display

> `readonly` **display**: `string`

Defined in: [src/core/model/address.ts:3](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L3)

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/address.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/address.ts#L12)

Chain-specific meaning of a recipient address. It reaches drivers in
`DriverOutput.variant` and is part of the intent hash, so it must hold only JSON scalars
(strings, finite numbers, booleans, `null`) under string keys, and should contain only
semantic fields that change what the transfer does (for example TON's `bounceable`),
never encoding-only choices such as a display alphabet. Omit it, or leave it empty,
when the address has no such meaning: an empty variant is no variant.
