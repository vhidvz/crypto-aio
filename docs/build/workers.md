---
title: Run workers and recover
description: Startup recovery, background workers, runOnce from a scheduler, and shutting down cleanly.
---

# Run workers and recover

Nobody needs to wait on an Operation: a process can call `transfer`, return, and even crash.
Background workers finish the job. They claim due Operations from the store, observe
them, rebroadcast dropped ones, report nonce gaps (`nonce.gap`), and apply proven verdicts.
Any number of processes can run workers on shared stores. Each claim carries a token, and a
worker whose claim expired and was taken over has its writes refused (`FENCING`).

```ts
const aio = new CryptoAio({ namespace: 'payments', stores, signers, wallets, chains, providers });
const report = await aio.operations.recover(); // at startup, before serving
// report: { rebroadcast, checked, skipped, failed, reconciled }
const stop = new AbortController();
const workers = aio.monitor.start({ workerId: `api-${process.pid}`, signal: stop.signal });
process.once('SIGTERM', () => stop.abort());
await workers;
await aio.close(); // closes native clients and pooled drivers
```

- `recover()` resends `signed` and ambiguously `submitted` Operations, checks the other
  signed ones on chain, and returns leaked nonces for reuse. `created`, `prepared`,
  `awaiting-signature` and `stalled` Operations need you, so it skips them with a
  `recovery.skipped` event.
- Workers and `recover()` **never sign and need no signer**. They read through the
  Operation's chain, network and library with the current configuration. A resend or a nonce
  reconciliation needs only the Operation's wallet, and a watch-only wallet is enough. You can
  rotate or remove a signer while Operations are in flight.
- A nonce that leaked in a crash (allocated, never stored) is also reclaimed by the next
  `transfer` or `prepareTransfer` from that wallet, so a quiet wallet never stays blocked.
- `aio.monitor.runOnce({ workerId, batch })` runs one pass and returns how many Operations it
  claimed. Use it from a scheduler.
- Call `close()` on the root container; a scope's `close()` does nothing. After it, handle
  methods and `native()` throw `StateError` (`INVALID_TRANSITION`). It also stops every
  `monitor.start()` loop, and a running `runOnce()` or `recover()` at its next check, so
  the closed container claims no more Operations; starting one afterwards throws
  `INVALID_TRANSITION` too.
- Tune timing with `lifecycle`: `pollIntervalMs`, `droppedGracePeriodMs`,
  `rebroadcastIntervalMs`, `leaseMs`, `claimLeaseMs`, `waitTimeoutMs` and `signTimeoutMs`.

## Next steps

- [Retries, ambiguity and recovery](../tour/recovery.md): what recovery does, and why it never signs.
- [Nonces, leases and many processes](../tour/ordering.md): how many workers share one store.
- [Go to production](./production.md): the checklist.
