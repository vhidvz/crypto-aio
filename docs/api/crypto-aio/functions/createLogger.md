[crypto-aio](../../index.md) / [crypto-aio](../index.md) / createLogger

# Function: createLogger()

> **createLogger**(`namespace?`, `write?`): [`Logger`](../interfaces/Logger.md)

Defined in: [src/core/events/logger.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L36)

Structured logger; fields are always redacted before they reach the writer.

## Parameters

### namespace?

`string` = `'crypto-aio'`

### write?

[`LogWriter`](../type-aliases/LogWriter.md) = `debugWriter`

## Returns

[`Logger`](../interfaces/Logger.md)
