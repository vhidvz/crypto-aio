[crypto-aio](../../index.md) / [crypto-aio](../index.md) / stringifyTagged

# Function: stringifyTagged()

> **stringifyTagged**(`value`): `string`

Defined in: [src/core/util/json.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/core/util/json.ts#L143)

JSON that round-trips bigint and Uint8Array (for external store implementations). Bytes
are read from the holder, not from the replacer's value: `toJSON` runs first, and a
Node.js `Buffer` (a Uint8Array, which the memory store keeps as bytes) would otherwise
arrive as `{ type: 'Buffer', data }` and read back as a plain object. The check is by tag,
as `clone` does, so bytes from another realm are bytes too.

## Parameters

### value

`unknown`

## Returns

`string`
