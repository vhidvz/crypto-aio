[crypto-aio](../../index.md) / [crypto-aio](../index.md) / createMemoryStores

# Function: createMemoryStores()

> **createMemoryStores**(`clock?`): [`Stores`](../interfaces/Stores.md)

Defined in: [src/core/store/memory.ts:432](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L432)

The four stores in memory, the default when `AioOptions.stores` leaves one out. Production
needs durable stores shared by every process (see the docs' "Write a durable store").

## Parameters

### clock?

[`Clock`](../interfaces/Clock.md) = `systemClock`

## Returns

[`Stores`](../interfaces/Stores.md)
