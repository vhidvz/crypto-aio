[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ScanEventBody

# Type Alias: ScanEventBody

> **ScanEventBody** = \{ `block`: [`Block`](../interfaces/Block.md); `transactions`: readonly [`Transaction`](../interfaces/Transaction.md)[]; `type`: `"block"`; \} \| \{ `removed`: readonly [`Checkpoint`](../interfaces/Checkpoint.md)[]; `to`: [`Checkpoint`](../interfaces/Checkpoint.md); `type`: `"rollback"`; \}

Defined in: [src/core/observe/scanner.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L49)

A scan event without its `ack()`: a delivered block, or a rollback to a checkpoint.
