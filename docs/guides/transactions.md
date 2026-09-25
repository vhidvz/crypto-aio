---
summary: Withdrawals, cold signing, confirmations, background workers, deposit scanning and error handling.
---

# Sending and receiving

This guide shows how to build withdrawals and deposits into a service. The examples run on
the fake chain (`bc = env.bc`; wrap awaited calls in `env.run(...)`, as in the
[tutorial](./tutorial.md)). They work the same way on a real family once its adapter ships.
Terms are defined in [Core concepts](./concepts.md).

## Sending

### `transfer`: build, sign and broadcast in one call

```ts
const sub = await bc.transfer(
  { to: 'fk1…', amount: '0.25', fee: 'fast', memo: 'invoice 381' },
  { idempotencyKey: withdrawal.id },
);
sub.operationId; // your handle on the Operation from now on
sub.attempt; // { id: <tx hash>, idKind: 'tx-hash', canonical: true }
```

`transfer` validates the intent, creates the Operation (or returns the existing one for this
key), reserves the ordering slot (the nonce), builds, runs the `beforeSign` hook, signs,
stores the signed Attempt, and broadcasts. It returns a `Submission`: the Operation view plus
`wait(options)`. A repeat with the same key resumes where the Operation stopped. It never
signs twice.

- `outputs: [{ to, amount }, …]` sends several outputs; it needs the `batch-transfer`
  capability.
- `asset` defaults to `'native'`. It also accepts a token ref, an asset id, or an alias
  registered for the handle's chain and network. Tokens need the `tokens` capability, and no
  shipped family has it yet.
- `memo` needs the `memo` capability.
- `options.signal` aborts the call. An abort after a possible broadcast is reported as
  ambiguous.

### Fees

`fee` is a speed (`'slow'`, `'normal'` (the default) or `'fast'`) or a family-specific
override object. The fake chain takes `fee: { fee: 5n }`. Each planned family defines its own
override fields with its adapter; the `FeeOverride` docs name `{ maxFeePerGas }` and
`{ satPerVByte }` as examples. Override amounts must be bigints or decimal strings, never
numbers (`INVALID_INTENT`). The fee is part of the `intentHash`, and an override is hashed as
written: `{ fee: 1n }` and `{ fee: '1' }` are different intents. Retry in the same form, or you
get `IDEMPOTENCY_CONFLICT`.

```ts
const estimate = await bc.estimateFee({ to, amount: '0.25', fee: 'fast' });
estimate.charges; // [{ amount: Amount, label: 'network' }]; a charge per asset and purpose
estimate.bound; // 'exact' | 'expected' | 'upper'
feeTotal(estimate, 'fakechain:local/native'); // Amount | undefined
```

### Cold, offline and asynchronous signing

A wallet without a signer, such as `{ publicKey: '<hex>' }`, is watch-only. `transfer` then
throws `SIGNER_UNAVAILABLE`, but `prepareTransfer` works. It builds and stores the unsigned
transaction and reserves the nonce. Then it returns the signing requests. You sign them
elsewhere and hand back the signatures:

```ts
const cold = aio.blockchain({ chain: 'fakechain', wallet: 'cold' }); // wallets.cold = { publicKey }
const prepared = await cold.prepareTransfer({ to, amount: 7n }, { idempotencyKey: 'cold-1' });
const requests = prepared.unsigned?.signingRequests ?? []; // { id, scheme, payload, publicKey }
const signatures = await offlineDevice.sign(requests); // SignatureBundle[]: { requestId, bytes, recovery? }
const sub = await cold.submitSignatures(prepared.operation.id, signatures);
```

The core verifies each signature against its request's public key (`SIGNATURE_MISMATCH`
otherwise). The Operation moves to `signed` only when every request is signed. You can submit
partial sets. A `callbackSigner` that answers `{ status: 'pending', ticket }` parks the
Operation in `awaiting-signature` in the same way. Finish it with `submitSignatures`, or call
`abandon(operationId)`. `abandon` works only before anything is signed. It releases the
nonce and cancels pending signer tickets.

## Lifecycle and `stalled`

```text
created -> prepared -> [awaiting-signature] -> signed -> submitted -> included -> final
   |           |                |                           |    ^
   +-----------+----------------+--> abandoned              v    |  (rebroadcast, replace,
   +-> failed (before signing: validation, funds, policy) stalled-+   cancel, proof)
submitted | stalled | included --> failed | expired | final   (only on proven evidence)
```

An Operation is **`stalled`** when a node refused its signed transaction for a reason that
can change, such as `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW` or `NONCE_TOO_HIGH`. `transfer`
throws that error, with `context.operationId`. The Operation keeps its nonce and its signed
bytes, because the transaction may still be valid later or may already be included.
Workers keep observing it, and `aio.on('operation.stalled', …)` tells you. What to do:

| Action | When | Capability |
| --- | --- | --- |
| `bc.rebroadcast(id)` | You fixed the cause (for example topped up the wallet); resends the same bytes | none |
| `bc.replace(id, { fee })` | The fee was too low; a new Attempt with the same nonce and a higher fee | `replace-fee`, synchronous signer |
| `bc.cancel(id, { fee? })` | You want to stop the payment; a conflicting self-transfer, `outcome: 'cancelled'` only if it wins at finality | `cancel`, synchronous signer |
| `bc.abandon(id)` | **Not** for `stalled`. Only for `created`, `prepared` or `awaiting-signature` | none |

`replace` is idempotent per fee spec: repeating the same `fee` returns the same replacement.
To bump again, pass a higher explicit override. A repeated `cancel` returns a pending cancel
unchanged. Only a cancel that a node refused or dropped is bumped, one step per call. Passing
`fee` builds a new cancel, but only while no cancel is on chain. `cancel` can lose the race:
if the original is already mined, it throws `NONCE_CONFLICT`, and the outcome stays
`executed`. Replace and cancel never happen automatically.

On expiry- and seqno-based chains (planned Tron, Solana and TON; `fakeexpiry` and
`fakeseqno` today), `bc.rebuild(id)` re-issues an Operation after its expiry is **proven**
(`expired`, error `TX_EXPIRED`). It adds a `rebuild` Attempt and reopens the Operation. Other
chains throw `UNSUPPORTED_CAPABILITY`. Replace, cancel and rebuild sign a new Attempt on the
spot, so they need a synchronous signer: a signer that answers `pending` fails them with
`SIGNING_FAILED`.

## Waiting and watching

```ts
const { status, operation } = await bc.waitForConfirmation(operationId, {
  finality: 'final', // or 'included'; or pass confirmations: n
  timeoutMs: 600_000,
});
for await (const { status } of bc.watch(operationId, { signal })) log(status.state);
const now = await bc.getTransactionStatus(operationId); // one read
```

- The `ref` is an Operation id, an Attempt ref (`sub.attempt.id`, the transaction hash) or
  a transaction hash the monitor has observed. An Attempt's own id (`attempts[i].id`) is not
  a ref. Any other id is an unmanaged transaction, whose finality is `observed` only.
- For an Operation, `waitForConfirmation` rejects with the stored failure: `TX_REVERTED`,
  `TX_EXPIRED` or `TX_REPLACED` on proven evidence, `TX_REJECTED` when every Attempt was
  rejected, or the code of a failure before signing. An abandoned Operation gives
  `INVALID_TRANSITION`. An unmanaged transaction rejects with `TX_REVERTED` on observed
  finality. On `TIMEOUT` (retryable), nothing changed. Wait again.
- `sub.wait(options)` is the same as `waitForConfirmation(sub.operationId, options)`.

## Background workers and startup recovery

Nobody needs to wait on an Operation. Workers claim due Operations from the store, observe
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
  methods and `native()` throw `StateError` (`INVALID_TRANSITION`).
- Tune timing with `lifecycle`: `pollIntervalMs`, `droppedGracePeriodMs`,
  `rebroadcastIntervalMs`, `leaseMs`, `claimLeaseMs`, `waitTimeoutMs` and `signTimeoutMs`.

## Receiving

### Scanner (`block-scan`)

```ts
const scanner = bc.scanner({
  cursorKey: 'deposits', // durable position, per namespace, chain and network
  from: 'latest', // where a NEW cursor starts; ignored once one is stored
  mode: 'final', // only finalized blocks; the default 'head' follows the tip
  filter: { addresses: depositAddresses },
});
const mine = new Set(depositAddresses); // canonical strings (see bc.normalizeAddress)
for await (const event of scanner) {
  if (event.type === 'block') {
    for (const tx of event.transactions)
      for (const transfer of tx.transfers) {
        if (!mine.has(transfer.to.canonical)) continue; // the filter is a superset
        if (transfer.unresolved) await flagForReview(transfer.id, transfer.unresolved);
        else await creditOnce(transfer.id, transfer.asset, transfer.amount);
      }
  } else {
    await revertBlocks(event.removed); // 'rollback': back to event.to
  }
  await event.ack(); // commits the cursor; required before the next event
}
```

- **Credit only your own deposits.** `filter.addresses` returns every transaction with a
  transfer from **or** to one of those addresses, and it may carry other transfers too.
  Credit only transfers whose `to` is a deposit address, or your own sweeps look like deposits.
- **At least once.** A block may be delivered again after a crash, so dedupe on
  `transfer.id` (`<txId>:<locator>`).
- **Rollback.** In `head` mode, a reorg within `reorgWindow` blocks produces a `rollback`
  event to the common ancestor, then the new branch. The scanner checks a stored cursor
  against the canonical chain on restart. It decides a rollback only when a quorum-served
  block hash confirms it, and never from a stale view. In `final` mode a rollback can still
  come from a provider inconsistency, so handle it there too. The mode is not stored with the
  cursor: a head-mode cursor resumed in `final` mode keeps the blocks it already delivered.
- **`SCANNER_REORG_TOO_DEEP`.** The chain diverged deeper than the window. The scanner stops
  instead of guessing. Stop crediting, investigate, then reset explicitly: scan under a new
  `cursorKey`, or `put` a checkpoint `{ height, hash, recent }` through your `CursorStore`.
  `recent` may be empty; the scanner refills it. The store key is currently
  `<namespace>:<chain>:<network>:<cursorKey>`.
- `filter.assets` is a hint to the driver, not a guarantee. Check `transfer.asset` yourself.
- **Unresolved assets.** A transfer whose asset cannot be resolved, such as a spam token
  with unusable metadata, does not stop the scanner. It arrives as an `UnresolvedTransfer`:
  `asset` and `amount` are `undefined`, and `unresolved` holds `{ asset, amount, code }`,
  meaning the raw `AssetRef`, the amount in base units as a bigint, and the reason (such as
  `ASSET_RESOLUTION`). Its transaction has `decoding: 'partial'`. `getTransaction` and
  `history` return the same marker. A retryable failure still fails the read.
- Stop an idle scanner with `signal`. `iterator.return()` acts only after a pending `next()`.

### Address history (`address-history`)

`bc.history(address, { cursor?, limit? })` returns `{ items: Transaction[], next? }` from an
indexer. It needs an indexer provider. The fake chain has none, so it throws
`UNSUPPORTED_CAPABILITY` there.

## Error handling

Find the Operation with `error.context.operationId`, then read its state with
`bc.getOperation(id)`. The rule: **never create a new transfer while the old one might
land.**

| Code | Meaning | Safe action |
| --- | --- | --- |
| `ambiguous: true` (any code) | Outcome unknown, for example a lost broadcast reply | Retry with the **same** key, or let workers resolve it |
| `INVALID_AMOUNT`, `INVALID_ADDRESS`, `INVALID_INTENT`, `ASSET_RESOLUTION` | Input refused; nothing stored | Fix the input |
| `IDEMPOTENCY_CONFLICT` | Key reused for a different intent | Treat it as a bug; inspect the existing Operation |
| `INSUFFICIENT_FUNDS`, `POLICY_REJECTED` with state `failed` | Failed before signing; nonce released | Fix the cause; retry with a **new** key |
| `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW`, `NONCE_TOO_HIGH`, `TX_REFUSED` with state `stalled` | Node refused signed bytes | `rebroadcast` after the fix, `replace` or `cancel`; never a new key |
| `NONCE_CONFLICT` | A cancel or replacement lost: the original is already mined | Wait for the original |
| `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` | Proven terminal failure | Reconcile; a new transfer with a new key is safe |
| `TX_REJECTED` | Nodes rejected every Attempt as never valid; nonce released | Fix the cause; retry with a **new** key |
| `TIMEOUT` | A wait ran out; state unchanged | Wait again |
| `SEQUENCE_BUSY` | A seqno wallet still has a message in flight | Retry later with the same key |
| `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_INCONSISTENT` (not ambiguous) | A read failed | Retry later |
| `PROVIDER_MISCONFIGURED` | The endpoint serves another network | Fix the configuration |
| `SIGNER_UNAVAILABLE` | Watch-only wallet or unknown signer | Use `prepareTransfer`, or fix the configuration |
| `INVALID_TRANSITION` | Not allowed in this state, or the container is closed | Read the state first |
| `UNSUPPORTED_CAPABILITY` | The handle cannot do this | Check `bc.supports(…)` |
| `SCANNER_REORG_TOO_DEEP` | Reorg deeper than the scanner window | Stop crediting; reset the cursor explicitly |
