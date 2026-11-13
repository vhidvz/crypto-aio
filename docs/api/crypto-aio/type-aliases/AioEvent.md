[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioEvent

# Type Alias: AioEvent\<E\>

> **AioEvent**\<`E`\> = `{ [K in E]: AioEvents[K] & { at: number; type: K } }`\[`E`\]

Defined in: [src/core/events/types.ts:146](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L146)

An event as a listener gets it: its payload, with its `type` and the time `at` it fired.

## Type Parameters

<a id="e"></a>

### E

`E` *extends* [`AioEventName`](AioEventName.md) = [`AioEventName`](AioEventName.md)
