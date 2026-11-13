[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ScanEvent

# Type Alias: ScanEvent

> **ScanEvent** = [`ScanEventBody`](ScanEventBody.md) & `object`

Defined in: [src/core/observe/scanner.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L69)

A scan event: `ack()` commits the cursor past it, so a restarted scan does not deliver it
again. Delivery is at least once: an event not yet acknowledged comes again.

## Type Declaration

### ack()

> **ack**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>
