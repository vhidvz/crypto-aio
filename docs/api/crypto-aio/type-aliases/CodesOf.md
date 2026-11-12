[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CodesOf

# Type Alias: CodesOf\<C\>

> **CodesOf**\<`C`\> = `{ [K in ErrorCode]: typeof ERROR_CODES[K]["category"] extends C ? K : never }`\[[`ErrorCode`](ErrorCode.md)\]

Defined in: [src/core/errors/codes.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/codes.ts#L71)

The codes of one category.

## Type Parameters

<a id="c"></a>

### C

`C` *extends* [`ErrorCategory`](ErrorCategory.md)
