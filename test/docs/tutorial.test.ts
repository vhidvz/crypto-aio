// Runnable companion of docs/guides/tutorial.md ("Tutorial: review the concepts in 20
// minutes"). Each step's body here is the code block of the matching guide step, character
// for character; tutorial-sync.test.ts checks that. The guide imports the package names, and
// this file imports the same entry points from source, as test/e2e/public-api.test.ts does:
//   'crypto-aio'         -> '../../src'
//   'crypto-aio/testing' -> '../../src/testing'
import { inspect } from 'node:util';
import {
  Amount,
  CryptoAio,
  MemoryOperationStore,
  createLogger,
  isCryptoAioError,
  secret,
  type ScanEvent,
} from '../../src';
import {
  CrashError,
  FakeClock,
  FakeFetch,
  FaultyOperationStore,
  createFakeEnv,
  drive,
  fakePlugin,
  rpcResult,
  type FakeEnv,
} from '../../src/testing';

// ---- Before you start: the two helpers of the guide's first code block ----

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

describe('tutorial: review the concepts in 20 minutes', () => {
  it('step 1: env and handle', async () => {
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
  });

  it('step 2: amounts and addresses', async () => {
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
  });

  it('step 3: the first transfer and its states', async () => {
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
  });

  it('step 4: proven finality vs observed inclusion', async () => {
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
  });

  it('step 5: idempotency', async () => {
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
  });

  it('step 6: five concurrent transfers get consecutive nonces', async () => {
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
  });

  it('step 7: an ambiguous failure, retried with the same key', async () => {
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
  });

  it('step 8: crash and recovery', async () => {
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
  });

  it('step 9: receiving with a scanner, and a reorg rollback', async () => {
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
  });

  it('step 10: secrets never leak', async () => {
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
  });
});
