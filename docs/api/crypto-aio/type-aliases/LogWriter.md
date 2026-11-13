[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LogWriter

# Type Alias: LogWriter

> **LogWriter** = (`level`, `namespace`, `message`, `fields?`) => `void`

Defined in: [src/core/events/logger.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L27)

Writes one redacted entry, for `createLogger`. A port you may implement: it never gains
a required parameter in a 1.x release.

## Parameters

### level

[`LogLevel`](LogLevel.md)

### namespace

`string`

### message

`string`

### fields?

`Record`\<`string`, `unknown`\>

## Returns

`void`
