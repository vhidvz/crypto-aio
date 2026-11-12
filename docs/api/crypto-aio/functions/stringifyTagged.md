[crypto-aio](../../index.md) / [crypto-aio](../index.md) / stringifyTagged

# Function: stringifyTagged()

> **stringifyTagged**(`value`): `string`

Defined in: [src/core/util/json.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/core/util/json.ts#L158)

JSON that round-trips bigint and Uint8Array (for external store implementations). Bytes
are read from the holder, not from the replacer's value: `toJSON` runs first, and a
Node.js `Buffer` (a Uint8Array, which the memory store keeps as bytes) would otherwise
arrive as `{ type: 'Buffer', data }` and read back as a plain object. The check is by tag,
as `clone` does, so bytes from another realm are bytes too.

A plain object whose only key is `$bigint` or `$bytes` with a string value cannot be
written: `parseTagged` would read it back as a bigint or bytes. It throws a `TypeError`,
as `JSON.stringify` does for a value it cannot encode, so a store refuses the write
instead of storing data that would read back changed. The core never stores one.

## Parameters

### value

`unknown`

## Returns

`string`
