[crypto-aio](../../index.md) / [crypto-aio](../index.md) / createLogger

# Function: createLogger()

> **createLogger**(`namespace?`, `write?`): [`Logger`](../interfaces/Logger.md)

Defined in: [src/core/events/logger.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L51)

Structured logger; fields are always redacted before they reach the writer. The default
writer logs through `debug` under `<namespace>:<level>`.

## Parameters

### namespace?

`string` = `'crypto-aio'`

### write?

[`LogWriter`](../type-aliases/LogWriter.md) = `debugWriter`

## Returns

[`Logger`](../interfaces/Logger.md)
