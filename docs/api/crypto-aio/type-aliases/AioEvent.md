[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioEvent

# Type Alias: AioEvent\<E\>

> **AioEvent**\<`E`\> = `{ [K in E]: AioEvents[K] & { at: number; type: K } }`\[`E`\]

Defined in: [src/core/events/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L121)

## Type Parameters

### E

`E` *extends* [`AioEventName`](AioEventName.md) = [`AioEventName`](AioEventName.md)
