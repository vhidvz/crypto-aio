[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Scanner

# Interface: Scanner

Defined in: [src/core/observe/scanner.ts:167](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L167)

Reorg-aware, at-least-once block scanner. Each event's `ack()` commits the
cursor (compare-and-set on its version, so two scanners sharing a `cursorKey` never both
commit the same advance); asking for the next event first throws `INVALID_TRANSITION`.
A view that cannot decide (stale, or missing a block) never causes a rollback: the
scanner waits a poll interval and looks again, as it does after a retryable provider error.

A cursor stopped by `SCANNER_REORG_TOO_DEEP` is reset explicitly: scan under a new
`cursorKey`, or `put` a checkpoint `{ height, hash, recent }` for its key through the
`CursorStore`. A checkpoint without `recent` is validated on its own block, and its
window is then refilled from the chain below that block.

## Implements

- `AsyncIterable`\<[`ScanEvent`](../type-aliases/ScanEvent.md)\>

## Methods

<a id="asynciterator"></a>

### \[asyncIterator\]()

> **\[asyncIterator\]**(): `AsyncIterator`\<[`ScanEvent`](../type-aliases/ScanEvent.md)\>

Defined in: [src/core/observe/scanner.ts:175](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L175)

#### Returns

`AsyncIterator`\<[`ScanEvent`](../type-aliases/ScanEvent.md)\>

#### Implementation of

`AsyncIterable.[asyncIterator]`
