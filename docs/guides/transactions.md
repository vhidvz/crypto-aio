---
summary: Withdrawals, cold signing, confirmations, background workers, deposit scanning and error handling.
---

# Sending and receiving

This guide shows how to build withdrawals and deposits into a service. The examples run on
the fake chain (`bc = env.bc`; wrap awaited calls in `env.run(...)`, as in the
[tutorial](./tutorial.md)). They work the same way on the EVM chains and on Tron, apart from
the EVM and Tron notes below. Terms are defined in [Core concepts](./concepts.md).

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
  capability. An EVM or Tron transfer has exactly one output.
- `asset` defaults to `'native'`. It also accepts a token ref, an asset id, or an alias
  registered for the handle's chain and network, such as `'USDC'` on `ethereum` mainnet.
  Tokens need the `tokens` capability: the EVM chains (ERC-20) and Tron (TRC-20) have it;
  the fake chain does not.
- `memo` needs the `memo` capability, which Tron has and EVM networks lack. A Tron memo is
  public forever and costs a fee ([Tron networks](./networks.md#tron-networks)).
- `options.signal` aborts the call. An abort after a possible broadcast is reported as
  ambiguous.

### Fees

`fee` is a speed (`'slow'`, `'normal'` (the default) or `'fast'`) or a family-specific
override object, whose fields each family's adapter defines. Override amounts must be
bigints or decimal strings, never numbers (`INVALID_INTENT`). The fake chain takes
`fee: { fee: 5n }`. EVM networks take `{ maxFeePerGas, maxPriorityFeePerGas, gasLimit? }`
(`evm-1559`) or `{ gasPrice, gasLimit? }` (`evm-legacy`) in wei (`EvmFeeOverride`), as
bigints only: a decimal string gives `INVALID_INTENT` there. Tron TRC-20 transfers take
`{ feeLimit }` in sun (`TronFeeOverride`), also as a bigint only. The fee is part of the
`intentHash`, and an override is hashed as written: `{ fee: 1n }` and `{ fee: '1' }` are
different intents. Retry in the same form, or you get `IDEMPOTENCY_CONFLICT`.

```ts
const estimate = await bc.estimateFee({ to, amount: '0.25', fee: 'fast' });
estimate.charges; // [{ amount: Amount, label: 'network' }]; a charge per asset and purpose
estimate.bound; // 'exact' | 'expected' | 'upper'
feeTotal(estimate, 'fakechain:local/native'); // Amount | undefined
```

On `evm-1559` networks, `slow`, `normal` and `fast` take the median, over the last 15
blocks, of the 10th, 25th or 50th percentile tip (at least the network's floor, 25 gwei on
Polygon mainnet), and the fee cap allows the base fee to double. On `evm-legacy` networks
they scale `eth_gasPrice` by 100%, 110% or 125%. The gas limit is the node's estimate,
plus 20% for anything but a plain transfer. The `network` charge is an `upper` bound, and
`details.expected` (`EvmFeeDetails`) the likely cost. On OP Stack chains the L1 data fee is a
separate `l1-data` charge, and the bound is `expected`, since that fee moves with L1 prices.
An override's `gasLimit` skips `eth_estimateGas`, the check that refuses a call that would
fail: any call that would revert or run out of gas, such as a token transfer or a payment
to a contract that refuses it, is then signed, broadcast, and burns its gas. The balance
check still runs.

On Tron, `slow`, `normal` and `fast` give the same estimate, since Tron has no fee market.
The `tron` fee has `bandwidth`, `energy`, `activation` and `memo` charges, all in TRX and
each possibly 0, as an `upper` bound. A TRC-20 transfer's `feeLimit` covers its simulated
energy plus a margin, up to the network's maximum fee limit and the handle's `maxFeeLimit`
option (100 TRX by default); `{ feeLimit }` may raise it to the lower of the two but never
set it below the estimate.
[Tron networks](./networks.md#tron-networks) explains the charges and the ceiling.

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

Where the chain's driver can read one, `submitSignatures` also takes the whole transaction
signed elsewhere, for example a PSBT back from a hardware wallet:
`cold.submitSignatures(prepared.operation.id, { encoding: 'base64', data: signedPsbt })`. The
driver extracts the signatures, and only their bytes are used: the core verifies each one
against its stored request, exactly like a bundle. A payload that is not the prepared
transaction is refused: `INVALID_INTENT` when the driver tells it apart, otherwise
`SIGNATURE_MISMATCH` from the core's check. A chain whose driver cannot read one throws
`UNSUPPORTED_CAPABILITY` (submit bundles there). The Operation must belong to the handle's
chain, network and wallet, as for bundles.

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

On EVM, a replacement or cancel reuses the nonce and must raise both the fee cap and the tip
(the gas price on `evm-legacy`) by the network's `replacement.minBumpPercent` (10), or it
throws `FEE_TOO_LOW`. A speed re-estimates the fee, which on a quiet network is often not
10% higher; on Polygon mainnet all three speeds often sit at the 25 gwei tip floor. So pass
an explicit override that raises each price by at least 10%. A cancel is a zero-value
transfer to yourself, at the smallest valid bump unless you pass `fee`. Arbitrum has no
mempool, so it supports neither (`UNSUPPORTED_CAPABILITY`).

On expiry- and seqno-based chains (Tron today; planned Solana and TON; `fakeexpiry` and
`fakeseqno` in the testing kit), `bc.rebuild(id)` re-issues an Operation after its expiry is
**proven** (`expired`, error `TX_EXPIRED`). It adds a `rebuild` Attempt and reopens the
Operation. Other chains throw `UNSUPPORTED_CAPABILITY`. Replace, cancel and rebuild sign a
new Attempt on the spot, so they need a synchronous signer: a signer that answers `pending`
fails them with `SIGNING_FAILED`.

**On Tron, a refusal means: do not pay again; the Operation is still live.** Tron has no
replace and no cancel (`UNSUPPORTED_CAPABILITY`). A Tron Operation is `stalled` with
`TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` when a node refused its signed bytes, and
those bytes may still land. `TX_REFUSED` also covers a node that claims the bytes can never
be valid when the library cannot confirm that claim from the bytes it sent: a lying or buggy
endpoint may have relayed them anyway, or may keep them to relay later. A liar and a genuine
refusal look the same, so repeat a call only with the **same** idempotency key, never a new
one. A `TX_EXPIRED` refusal is likewise one node's view at its own head, not proof. Fix the
cause and `bc.rebroadcast(id)` within the expiration window, or let the workers watch it:
the Operation ends `final` if the transaction lands, or `expired` once its expiry is proven,
and only then does `bc.rebuild(id)` sign a new Attempt.

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
- **EVM token verdicts.** An Operation's ERC-20 `transfer` counts as executed only if the
  token contract logged a `Transfer` from the sender to the recipient, of a positive amount
  (of any amount for a zero-amount transfer), as ERC-20 requires. The recipient and amount
  are read from the signed call. A fee-on-transfer token that delivers less than asked still
  counts. A token that returns `false` instead of reverting, logs its `Transfer` to another
  address or of nothing, or moves value without logging it, is reported failed
  (`TX_REVERTED`) **although its receipt succeeded, so value may have moved.** Before you
  pay again, check the chain: `bc.getTransaction(attempt.ref.id)` shows the receipt's own
  status (`status.state` is `included` when it succeeded, `failed` when it reverted), or
  read the recipient's token balance. Only your own Operations get this verdict;
  `getTransaction` and scans show the chain's view.
- **EVM proofs.** An Attempt whose transaction disappears is settled only once its nonce is
  proven used at a final height, read by block number (BSC's public nodes serve no state at
  the `finalized` tag). An endpoint without that state, such as a non-archive L2 node, makes
  the proof decide nothing (a retryable `PROVIDER_UNAVAILABLE`) until endpoints that serve it
  answer; so does any other JSON-RPC error on a proof read, since only a definitive answer
  proves "no". With one endpoint the proof quorum is 1, so configure two or more providers.
- **Tron token verdicts.** As on EVM, an Operation's TRC-20 `transfer` counts as executed
  only if its receipt succeeded and the token contract logged a `Transfer` from the sender
  to the recipient, of any positive amount (a fee-on-transfer token that delivers less still
  counts). A token whose receipt succeeded but logged no such `Transfer` is reported failed
  (`TX_REVERTED`, `status.reason` `token transfer not evidenced`) **although value may have
  moved**: check the chain (`bc.getTransaction(attempt.ref.id)`, or the recipient's token
  balance) before you pay again. A `Transfer` event from the token that does not decode
  leaves the Attempt undecided. A transfer that ran out of energy is failed (`out of
  energy`), and its fee is burned.
- **Tron proofs.** A Tron transaction that never landed is proven `expired` only once a
  solidified block passes its signed expiration, the reference block it names is attested,
  and every block between them is read by hash under the proof quorum without it. An index
  that lags, or an endpoint that cannot serve those blocks, decides nothing. With one
  provider the proof quorum is 1, so configure two or more
  ([Tron networks](./networks.md#tron-networks)).
- **Run the monitor.** A node answers "not found" for every transaction outside its index
  window (geth keeps the last 2,350,000 blocks: weeks on fast chains, under a year on
  Ethereum), so a missing receipt proves nothing. A transaction older than your endpoints'
  index window is resolved by its nonce: the proof finds the final block that used the nonce
  and reads the sender's transaction there. `TX_REPLACED` needs another transaction there;
  your own is proven final with its receipt from that block. That lookup reads the nonce at
  past heights, and a standard full node keeps only about the last 128 blocks of state
  (about 1 minute on BSC, 25 minutes on Ethereum). Anything older needs an archive node.
  Without one, the Attempt stays undecided, and it is never failed. So an external
  replacement that the monitor first notices later than that stays undecided until an
  archive endpoint answers. A nonce consumed by an EIP-7702 authorization, rather than by a
  transaction from your address, also stays undecided and is never failed.

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
- **EVM.** Blocks carry native transfers and ERC-20 `Transfer` logs. A transaction that ran
  contract code is `decoding: 'partial'`: internal transfers need traces, which are out of
  scope. A plain POL transfer on Polygon is `complete`, because bor's system logs are ignored
  for it. A scan, filtered or not, reads each block's receipts in one `eth_getBlockReceipts`
  call and takes token transfers from them, never from a log index that may lag. Without
  that method, an unfiltered scan reads one receipt per transaction, and a filtered one asks
  `eth_getLogs`. When that answers nothing but the block's bloom may hold a `Transfer`, the
  scan reads every receipt of the block before it trusts the empty answer. So for deposit
  scanning, prefer endpoints that serve `eth_getBlockReceipts`.
- **Tron.** Blocks carry TRX transfers and TRC-20 `Transfer` events from any contract, so
  check `transfer.asset`: a copycat token has its own contract. A contract call is
  `decoding: 'partial'`, since TRX can move inside it without an event, and a TRC-10
  transfer is not decoded (`decoding: 'none'`). A memo arrives on each transfer as
  `transfer.memo` when it is UTF-8 text. Credit in `final` mode, on solidified blocks.

### Address history (`address-history`)

`bc.history(address, { cursor?, limit? })` returns `{ items: Transaction[], next? }` from an
indexer. It needs an indexer provider. The fake chain has none, and the EVM family does not
support one yet, so both throw `UNSUPPORTED_CAPABILITY`. Tron serves it from TronGrid: name
the `trongrid` or `public` preset as the handle's `indexer`.

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
| `NONCE_CONFLICT` with `details.heldBy` | The signed transaction is identical to another Operation's, so it would pay once for both; nothing was sent. From `transfer` or `submitSignatures` the Operation is `failed`, or, if it is still `prepared` or `awaiting-signature` (a renew or version conflict), repeat with the **same** key (for `submitSignatures`, resubmit the signatures) so it is refused and failed. From `replace`, `cancel` or `rebuild` it is unchanged | `failed`: retry with a **new** key. `replace` or `cancel`: use another fee spec. `rebuild`: rebuild later. A later build (a new block, or the driver's build variant) gives different bytes |
| `SEQUENCE_BUSY`: "another operation is recording the same transaction; retry" | Another process is recording an identical transaction right now; nothing was recorded | Repeat the call (the **same** key, fee spec or signatures). For `submitSignatures`, resubmit the signatures |
| `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` | Proven terminal failure. For `TX_REPLACED`, another transaction is final in the slot | Reconcile; a new transfer with a new key is safe, except for an EVM token `TX_REVERTED` whose receipt succeeded: value may have moved, so check the chain first ([EVM token verdicts](#waiting-and-watching)) |
| `TX_REJECTED` | Nodes rejected every Attempt as never valid; nonce released | Fix the cause; retry with a **new** key |
| Tron: `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes, or claimed they are invalid; they may still land. A liar and a genuine refusal look the same | Never pay again: repeat only with the **same** key. `rebroadcast` after the fix; `rebuild` only once the Operation is `expired` (see "Lifecycle and `stalled`" above) |
| Tron: `TX_REVERTED` with reason `token transfer not evidenced` | The token call succeeded on chain but logged no `Transfer` to the recipient; value may have moved | Check the chain before you pay again ([Tron token verdicts](#waiting-and-watching)) |
| `TIMEOUT` | A wait ran out; state unchanged | Wait again |
| `SEQUENCE_BUSY` | A seqno wallet still has a message in flight | Retry later with the same key |
| `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_INCONSISTENT` (not ambiguous) | A read failed | Retry later |
| `PROVIDER_MISCONFIGURED` | The endpoint serves another network | Fix the configuration |
| `SIGNER_UNAVAILABLE` | Watch-only wallet or unknown signer | Use `prepareTransfer`, or fix the configuration |
| `INVALID_TRANSITION` | Not allowed in this state, or the container is closed | Read the state first |
| `UNSUPPORTED_CAPABILITY` | The handle cannot do this | Check `bc.supports(…)` |
| `SCANNER_REORG_TOO_DEEP` | Reorg deeper than the scanner window | Stop crediting; reset the cursor explicitly |
