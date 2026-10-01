---
title: Hands-on tutorial
parent: Get started
nav_order: 3
description: Ten hands-on steps on the fake chain that review the main concepts, in about 20 minutes.
---

# Hands-on tutorial

Ten steps, about 20 minutes. Each step runs one idea from
[Core concepts](../reference/concepts.md): a snippet, what to observe, the concept, and a
**Check yourself** box. It all runs on the fake chain, with no network. By the end you will
have watched crypto-aio keep its promises under concurrency, lost replies, a crash, a reorg
and a leaked secret.

> [!TIP]
> Coming from the [learning path](../learn/index.md)? Every step here is an idea from a
> lesson, now running for real. Coming from the [Quick start](./quick-start.md)? Skim
> [crypto-aio in 10 minutes](./mental-model.md) first; each step links to the concept it uses.

## Before you start

The snippets are Jest test bodies (`pnpm test test/docs/tutorial.test.ts` runs them): each
`expect` line is something to observe. On the fake chain, time moves only when the kit's clock
advances, which `env.run(promise)` does until the promise settles, and blocks appear only when
you call `env.chain.mine()`. Import these names and define two helpers:

```ts
import { inspect } from 'node:util';
import { Amount, CryptoAio, MemoryOperationStore, createLogger, isCryptoAioError, secret,
  type ScanEvent } from 'crypto-aio';
import { CrashError, FakeClock, FakeFetch, FaultyOperationStore, createFakeEnv, drive,
  fakePlugin, rpcResult, type FakeEnv } from 'crypto-aio/testing';

/** Mines one block per second of fake time until `promise` settles. */
async function mineWhile<T>(env: FakeEnv, promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let blocks = 0; blocks < 100 && !done; blocks++) {
    env.chain.mine();
    await env.clock.advance(1_000);
  }
  return tracked;
}

/** Reads the next scanner event on fake time. */
async function next(env: FakeEnv, events: AsyncIterator<ScanEvent>): Promise<ScanEvent> {
  const result = await env.run(events.next(), 500);
  if (result.done) throw new Error('the scanner stopped');
  return result.value;
}
```

## Step 1: Env and handle

```ts
const env = await createFakeEnv();
const bc = env.bc;
expect(bc.chain).toBe('fakechain');
expect(bc.network).toBe('local');
expect(bc.library).toBe('fake-sdk');
expect(bc.supports('replace-fee')).toBe(true);
expect(bc.supports('tokens')).toBe(false);

const patient = bc.with({ confirmations: 5 });
expect(patient).not.toBe(bc);
expect(patient.config.confirmations).toBe(5);
expect(bc.config.confirmations).toBe(2); // the original handle is unchanged
expect(Object.isFrozen(bc)).toBe(true);
```

**Observe:** `createFakeEnv()` returns a container (`env.aio`) and a frozen handle (`env.bc`);
`with()` returns a new handle. **Concept:** [handle](../reference/concepts.md#container-scope-and-handle)
and [capability](../reference/concepts.md#capability).

> **Check yourself:** (1) After `bc.with({ confirmations: 5 })`, what changes for Operations
> started from `bc`? (2) What does a call that needs `tokens` do on this handle?

<details><summary>Answers</summary>

(1) Nothing: `with()` returns a new handle, and each Operation keeps a frozen copy of its
context. (2) It throws `UnsupportedCapabilityError` (`UNSUPPORTED_CAPABILITY`).

</details>

## Step 2: Amounts and addresses

```ts
const env = await createFakeEnv();
const me = await env.run(env.bc.walletAddress());
expect(me.canonical).toBe(env.address);
expect(await env.run(env.bc.validateAddress('0xnot-a-fake-address'))).toBe(false);
const balance = await env.run(env.bc.getBalance(me.canonical));
expect(balance.amount.format()).toBe('0.01 FAKE');

const fake = balance.asset; // FAKE has 8 decimals
expect(Amount.parse('0.001', fake).base).toBe(100_000n); // string: decimal units
expect(Amount.from(100_000n, fake).format()).toBe('0.001 FAKE'); // bigint: base units

const to = env.stranger();
const number = await env
  .run(env.bc.transfer({ to, amount: 0.001 as never })) // `as never`: untyped input
  .catch((e: unknown) => e);
expect(number).toMatchObject({ code: 'INVALID_AMOUNT', category: 'validation' });
const tooPrecise = await env
  .run(env.bc.transfer({ to, amount: '0.000000001' }))
  .catch((e: unknown) => e);
expect(tooPrecise).toMatchObject({ code: 'INVALID_AMOUNT' });
expect(await env.run(env.aio.operations.list())).toHaveLength(0); // nothing stored
```

**Observe:** `'0.001'` and `100_000n` are the same amount (FAKE has 8 decimals). A JS number,
or too many decimals, is refused with `INVALID_AMOUNT` before anything is stored.
**Concept:** [Amount](../reference/concepts.md#asset-and-amount) and
[addresses](../reference/concepts.md#wallet-signer-and-address).

> **Check yourself:** (1) On FAKE, what do `amount: 5n` and `amount: '5'` mean? (2) Why is
> `0.1` refused instead of rounded?

<details><summary>Answers</summary>

(1) `5n` is 5 base units (0.00000005 FAKE); `'5'` is 5 FAKE (500 000 000 base units).
(2) A float cannot hold every decimal exactly, and the library never guesses with money.

</details>

## Step 3: The first transfer and its states

```ts
const env = await createFakeEnv();
const seen: string[] = [];
env.aio.on('operation.state', (event) => seen.push(event.to));

const intent = { to: env.stranger(), amount: '0.001' };
const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'order-1001' }));
expect(seen).toEqual(['created', 'prepared', 'signed', 'submitted']);
expect(sub.state).toBe('submitted');
expect(sub.attempt).toMatchObject({ idKind: 'tx-hash', canonical: true });
const [attempt] = sub.attempts;
expect(attempt?.status).toMatchObject({ state: 'pending', evidence: 'observed' });
```

**Observe:** one call moves the Operation through `created`, `prepared` (built, nonce
reserved), `signed` (signed bytes stored) and `submitted` (broadcast). **Concept:**
[Operation and Attempt](../reference/concepts.md#operation-and-attempt), and
[Operation states](../reference/concepts.md#operation-states).

> **Check yourself:** (1) Why is `signed` stored before `submitted`? (2) Does `submitted`
> mean the payment will land?

<details><summary>Answers</summary>

(1) So that after a crash the library resends exactly those bytes and never signs a second
transaction. (2) No. Only `final` is a settled result.

</details>

## Step 4: Proven finality vs observed inclusion

```ts
const env = await createFakeEnv();
const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));

const late = await env
  .run(env.bc.waitForConfirmation(sub.operationId, { timeoutMs: 3_000 }), 500)
  .catch((e: unknown) => e);
expect(late).toMatchObject({ code: 'TIMEOUT', retryable: true });
const view = await env.run(env.bc.getOperation(sub.operationId));
expect(view?.state).toBe('submitted'); // waiting changed nothing

env.chain.mine();
const included = await env.run(
  env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }),
);
expect(included.status).toMatchObject({ state: 'included', evidence: 'observed' });

const final = await mineWhile(env, sub.wait({ finality: 'final' }));
expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
```

**Observe:** a timed-out wait throws a retryable `TIMEOUT` and changes nothing. One block gives
`included` with `observed` evidence; `finality: 'final'` resolves only on `proven` evidence.
**Concept:** [evidence and finality](../reference/concepts.md#evidence-and-finality).

> **Check yourself:** (1) Should an exchange complete a withdrawal on `included`? (2) A wait
> timed out. Did the transfer fail?

<details><summary>Answers</summary>

(1) No. `included` is one endpoint's view, and a reorg can undo it. Complete it on `final`
with `proven` evidence. (2) No. Wait again, or let the background workers finish it.

</details>

## Step 5: Idempotency

```ts
const env = await createFakeEnv();
const to = env.stranger();
const key = { idempotencyKey: 'payout-77' };
const first = await env.run(env.bc.transfer({ to, amount: '0.001' }, key));
const again = await env.run(env.bc.transfer({ to, amount: 100_000n }, key));
expect(again.operationId).toBe(first.operationId); // same intent, other input form
expect(env.chain.sendCount(first.attempt?.id ?? '')).toBe(1);

const other = await env
  .run(env.bc.transfer({ to, amount: '0.002' }, key))
  .catch((e: unknown) => e);
expect(other).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', category: 'state' });
expect(await env.run(env.aio.operations.list())).toHaveLength(1);
```

**Observe:** the same key with the same intent in another form returns the same Operation and
sends nothing new. The same key with another amount throws `IDEMPOTENCY_CONFLICT`.
**Concept:** [idempotency key and `intentHash`](../reference/concepts.md#operation-and-attempt).

> **Check yourself:** (1) Where should an idempotency key come from?

<details><summary>Answers</summary>

(1) From your own durable record, such as the withdrawal id, stored before you call
`transfer`, so that a retry after a crash reuses it.

</details>

## Step 6: Five concurrent transfers get consecutive nonces

```ts
const env = await createFakeEnv();
const nonces: string[] = [];
env.aio.on('nonce.allocated', (event) => nonces.push(event.value));

const transfers = Array.from({ length: 5 }, (_, i) =>
  env.bc.transfer(
    { to: env.stranger(), amount: BigInt(i + 1) },
    { idempotencyKey: `batch-${i}` },
  ),
);
const subs = await env.run(Promise.all(transfers), 10);
expect([...nonces].sort()).toEqual(['0', '1', '2', '3', '4']);

const finals = await mineWhile(
  env,
  Promise.all(subs.map((sub) => sub.wait({ finality: 'final' }))),
);
expect(finals.map((f) => f.status.state)).toEqual(Array(5).fill('final'));
expect(env.chain.nonce(env.address)).toBe(5n);
```

**Observe:** five concurrent transfers from one address get the nonces 0 to 4, with no gap and
no duplicate, and all reach `final`. **Concept:** [ordering slot and address lease](../reference/concepts.md#ordering-slot-and-address-lease):
the lease (`LockManager`) serializes nonce allocation (`SequenceStore`).

> **Check yourself:** (1) Two processes send from the same wallet. What must they share?

<details><summary>Answers</summary>

(1) The stores (`LockManager`, `SequenceStore`, `OperationStore`). Memory stores work in one
process only; across processes, use shared stores that pass the contract suites.

</details>

## Step 7: An ambiguous failure, retried with the same key

```ts
const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
let signings = 0;
env.aio.on('signer.requested', () => signings++);
// The node accepts the next broadcast, but the reply is lost (HTTP 504).
env.chain.configureEndpoint('main', { acceptThenFail: true });
const intent = { to: env.stranger(), amount: 3n };
const key = { idempotencyKey: 'withdrawal-9' };

const error = await env.run(env.bc.transfer(intent, key)).catch((e: unknown) => e);
if (!isCryptoAioError(error)) throw error;
expect(error.ambiguous).toBe(true);
const operationId = String(error.context.operationId);
expect(await env.run(env.bc.getOperation(operationId))).toMatchObject({
  state: 'submitted',
  ambiguous: true,
});

const retried = await env.run(env.bc.transfer(intent, key)); // the same key
expect(retried).toMatchObject({ operationId, ambiguous: false });
expect(signings).toBe(1); // the stored bytes were resent, never signed again
```

**Observe:** the node got the transaction, but the reply was lost, so the error is
`ambiguous`. The retry with the same key resends the stored bytes; the signer ran once.
**Concept:** [ambiguous errors](../reference/concepts.md#ambiguous-errors).

> **Check yourself:** (1) Why must you never retry with a new idempotency key?

<details><summary>Answers</summary>

(1) The first transaction may still land. A new key creates a second Operation, which means
a second payment.

</details>

## Step 8: Crash and recovery

```ts
const operations = new FaultyOperationStore(new MemoryOperationStore());
const env = await createFakeEnv({ stores: { operations } });
let signings = 0;
env.aio.on('signer.requested', () => signings++);
const to = env.stranger();
// The process "dies" right after the signed Attempt is stored, before the broadcast.
operations.crashOn({ method: 'appendAttempt', timing: 'after' });
await expect(
  env.run(env.bc.transfer({ to, amount: 7n }, { idempotencyKey: 'crash-1' })),
).rejects.toBeInstanceOf(CrashError);

const restarted = await env.restart({ killPrevious: true }); // same stores and chain
restarted.aio.on('signer.requested', () => signings++);
const report = await restarted.run(restarted.aio.operations.recover());
expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });

const [op] = await restarted.run(restarted.aio.operations.list());
const final = await mineWhile(
  restarted,
  restarted.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' }),
);
expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
expect(signings).toBe(1); // signed once, before the crash
expect(restarted.chain.balance(to)).toBe(7n); // paid once
```

**Observe:** the process dies right after the signed Attempt is stored. The new process
(`restart({ killPrevious: true })`) resends the stored bytes in `operations.recover()`: signed
once, paid once. **Concept:** write-ahead signing; recovery never signs. What recovery skips,
and why it needs no signer at all, is in
[Background workers and startup recovery](../build/workers.md).

> **Check yourself:** (1) Why did the restarted process not sign again? (2) Using that guide
> section: what does `recover()` do with a `prepared` Operation?

<details><summary>Answers</summary>

(1) The signed Attempt was stored before the crash, so `recover()` resent its bytes. (2) It
skips it and emits `recovery.skipped`. Repeat `transfer` with the same key, or `abandon`.

</details>

## Step 9: Receiving with a scanner, and a reorg rollback

```ts
const env = await createFakeEnv();
const customer = env.stranger();
await env.run(env.bc.transfer({ to: customer, amount: 7n }));
env.chain.mine(3); // blocks 1 to 3; the deposit lands in block 1

const scan = env.bc
  .scanner({ cursorKey: 'deposits', from: 1n, filter: { addresses: [customer] } })
  [Symbol.asyncIterator]();
const first = await next(env, scan);
if (first.type !== 'block') throw new Error('expected a block');
const [tx] = first.transactions;
expect(tx?.transfers[0]).toMatchObject({
  id: `${tx?.id}:native`, // deterministic: dedupe on it
  to: { canonical: customer },
  amount: { base: 7n },
});
await first.ack(); // commits the cursor
await (await next(env, scan)).ack(); // block 2
await (await next(env, scan)).ack(); // block 3

env.chain.reorg(2); // blocks 2 and 3 are replaced by a new branch
const rollback = await next(env, scan);
if (rollback.type !== 'rollback') throw new Error('expected a rollback');
expect(rollback.to.height).toBe(1n);
expect(rollback.removed.map((block) => block.height)).toEqual([3n, 2n]);
await rollback.ack();
expect(await next(env, scan)).toMatchObject({ type: 'block', block: { height: 2n } });
```

**Observe:** each `ack()` commits the durable cursor `deposits`; ack before asking for the
next event. After a reorg, the scanner rolls back to the common ancestor, then replays the new
branch. **Concept:** at-least-once delivery, durable cursors and reorg rollback.

> **Check yourself:** (1) The process crashes after crediting a block but before `ack()`.
> What happens? (2) What do you do with a `rollback` event?

<details><summary>Answers</summary>

(1) It is delivered again: dedupe on the transfer id (`<txId>:<locator>`). (2) Revert the
`removed` blocks, then `ack()`. To credit only finalized blocks, see `mode: 'final'` in
[Receiving](../build/receive.md).

</details>

## Step 10: Secrets never leak

```ts
const url = secret('https://node.test/v1/sk_live_TUTORIAL42');
const clock = new FakeClock();
const node = new FakeFetch().route('https://node.test', (request) => {
  const { method } = request.json<{ method: string }>();
  if (method === 'fake_identity') return rpcResult(request, 'fake-local');
  if (method === 'fake_blockNumber') return rpcResult(request, '0');
  // Any other call fails, and the low-level error message contains the secret URL.
  throw new TypeError('failed', { cause: new Error(`refused ${url.reveal()}`) });
});
const logs: unknown[] = [];
const aio = new CryptoAio({
  env: false,
  clock,
  logger: createLogger('tutorial', (...record) => logs.push(record)),
  plugins: [fakePlugin()],
  transport: { fetch: node.fetch, baseDelayMs: 1, maxDelayMs: 5 },
  providers: { node: { endpoints: [{ name: 'main', url }] } },
  chains: { fakechain: { provider: 'node' } },
});
const events: unknown[] = [];
aio.onAny((event) => events.push(event));
const bc = aio.blockchain({ chain: 'fakechain' });

const error = await drive(clock, bc.getBlock(1n)).catch((e: unknown) => e);
expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
expect(String(error)).toContain('<node/main>'); // an endpoint label, not the URL
const deep = { depth: Infinity };
const printed = [inspect(error, deep), JSON.stringify(error), inspect(events, deep)];
printed.push(inspect(logs, deep), JSON.stringify(bc.config), String(url));
expect(printed.join('\n')).not.toContain('sk_live_TUTORIAL42');
```

**Observe:** the URL is a `Secret`, and the low-level error contains it, yet the error, events,
logs and `bc.config` show only the endpoint label `<node/main>`. **Concept:**
[events and logging](../reference/concepts.md#events-and-logging), [secrets](../build/keys.md#secrets-and-redaction).

> **Check yourself:** (1) Which data may an event carry?

<details><summary>Answers</summary>

(1) Operational data only: ids, states, codes, heights, timings and sizes. Never addresses,
amounts, raw transactions, signatures or URLs.

</details>

## Recap

| Concept | Step |
| --- | --- |
| Container (`CryptoAio`), handle (`Blockchain`), `with()`, capabilities | 1 |
| Addresses, assets and `Amount` (bigint vs string, no JS numbers) | 2 |
| Operation, Attempt and Operation states | 3 |
| Evidence (`observed` vs `proven`), finality, `TIMEOUT` | 4 |
| Idempotency key, `intentHash`, `IDEMPOTENCY_CONFLICT` | 5 |
| Ordering: address lease and nonce allocation | 6 |
| Ambiguous errors: retry with the same key | 7 |
| Write-ahead signing, crash recovery, `operations.recover()` | 8 |
| Scanner: cursor, `ack`, at-least-once, rollback | 9 |
| `Secret`, redaction, operational-only events and logs | 10 |

Next, the [Build guides](../build/index.md) turn these flows into a service: start with
[Send a transfer](../build/send.md) and [Receive deposits](../build/receive.md).
