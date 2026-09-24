// End to end through the package entry points only: `crypto-aio` (src/index.ts),
// `crypto-aio/native` (src/native.ts) and `crypto-aio/testing` (src/testing/index.ts).
import { inspect } from 'node:util';
import {
  Amount,
  Blockchain,
  ChainError,
  CryptoAio,
  ERROR_CODES,
  Library,
  MemoryCursorStore,
  MemoryOperationStore,
  callbackSigner,
  configure,
  createLogger,
  isCryptoAioError,
  localSigner,
  noopLogger,
  secret,
  type ScanEvent,
  type Signer,
} from '../../src';
import { native } from '../../src/native';
import {
  CrashError,
  FakeChain,
  FakeClock,
  FakeFetch,
  FaultyOperationStore,
  createFakeEnv,
  describeCursorStoreContract,
  describeLockManagerContract,
  describeOperationStoreContract,
  describeSequenceStoreContract,
  drive,
  fakePlugin,
  rpcResult,
  type FakeEnv,
} from '../../src/testing';

/** Mines one block per step while advancing fake time until `promise` settles. */
async function mineWhile<T>(
  env: FakeEnv,
  promise: Promise<T>,
  maxSteps = 500,
): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < maxSteps && !done; i++) {
    env.chain.mine();
    await env.clock.advance(1_000);
  }
  return tracked;
}

async function take(
  env: FakeEnv,
  iterator: AsyncIterator<ScanEvent>,
): Promise<ScanEvent> {
  const result = await env.run(iterator.next(), 500);
  if (result.done) throw new Error('scanner ended');
  return result.value;
}

/** A local signer that counts its signing calls. */
function countingSigner(): { signer: Signer; calls: () => number } {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  let calls = 0;
  const signer = callbackSigner({
    id: 'hot',
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  });
  return { signer, calls: () => calls };
}

describe('public API', () => {
  it('exposes the entry points', () => {
    expect(typeof CryptoAio).toBe('function');
    expect(typeof Blockchain.create).toBe('function');
    expect(typeof configure).toBe('function');
    expect(typeof localSigner.generate).toBe('function');
    expect(String(secret('x'))).toBe('[REDACTED]');
    expect(Library.ETHERS).toBe('ethers');
    expect(isCryptoAioError(new ChainError('TX_REVERTED', 'x'))).toBe(true);
    expect(ERROR_CODES.STATE_UNRECORDED).toEqual({ category: 'state', retryable: true });
    expect(typeof Amount.parse).toBe('function');
    expect(typeof native).toBe('function');
    for (const kit of [
      FakeChain,
      FakeClock,
      FakeFetch,
      FaultyOperationStore,
      CrashError,
    ]) {
      expect(typeof kit).toBe('function');
    }
    expect(typeof createFakeEnv).toBe('function');
    for (const suite of [
      describeCursorStoreContract,
      describeLockManagerContract,
      describeOperationStoreContract,
      describeSequenceStoreContract,
    ]) {
      expect(typeof suite).toBe('function');
    }
    expect(fakePlugin().name).toBe('fake');
  });

  it('configures the default container with the fake plugin', async () => {
    const clock = new FakeClock();
    const chain = new FakeChain({ clock });
    const { signer } = localSigner.generate({ curves: ['secp256k1'], id: 'hot' });
    configure({
      env: false,
      clock,
      logger: noopLogger,
      plugins: [fakePlugin()],
      transport: { fetch: chain.fetch, baseDelayMs: 1, maxDelayMs: 5 },
      providers: { fake: { endpoints: [{ url: chain.endpoint('main') }] } },
      signers: { hot: signer },
      wallets: { main: { signer: 'hot' } },
      chains: { fakechain: { provider: 'fake', wallet: 'main' } },
    });
    const bc = Blockchain.create({ chain: 'fakechain' });
    expect(await drive(clock, bc.ready())).toBe(bc);
    const address = await drive(clock, bc.walletAddress());
    chain.fund(address.canonical, 1_000n);
    chain.mine();
    expect(await drive(clock, bc.getBlockHeight())).toBe(1n);
    const balance = await drive(clock, bc.getBalance(address.canonical));
    expect(balance.amount.format()).toBe('0.00001 FAKE');
  });

  it('runs a full transfer lifecycle to proven finality', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: '0.001' }, { idempotencyKey: 'e2e-1' }),
    );
    const final = await mineWhile(env, sub.wait({ finality: 'final' }));
    expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
    expect((await env.run(env.bc.getBalance(recipient))).amount.format()).toBe(
      '0.001 FAKE',
    );
  });

  // Review Focus 2: an idempotent retry expressed differently is the same Operation.
  it('returns the same Operation for a retry in another input form, and nothing else', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const recipient = env.stranger();
    const first = await env.run(
      env.bc.transfer({ to: recipient, amount: '0.001' }, { idempotencyKey: 'rf2' }),
    );
    const again = await env.run(
      env.bc.transfer(
        { to: recipient.toUpperCase().replace('FK1', 'fk1'), amount: 100_000n },
        { idempotencyKey: 'rf2' },
      ),
    );
    expect(again.operationId).toBe(first.operationId);
    expect(calls()).toBe(1);
    expect(env.chain.sendCount(first.attempt?.id ?? '')).toBe(1);
    await expect(
      env.run(
        env.bc.transfer({ to: recipient, amount: '0.002' }, { idempotencyKey: 'rf2' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  // Review Focus 3: concurrent transfers from one address get distinct consecutive nonces.
  it('lands five concurrent transfers from one address on consecutive nonces', async () => {
    const env = await createFakeEnv();
    const subs = await env.run(
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          env.bc.transfer(
            { to: env.stranger(), amount: BigInt(i + 1) },
            { idempotencyKey: `rf3-${i}` },
          ),
        ),
      ),
      10,
    );
    const nonces = await Promise.all(
      subs.map(async (sub) => {
        const reservation = (await env.stores.operations.get('default', sub.operationId))
          ?.reservation;
        return reservation?.kind === 'nonce' ? reservation.nonce : undefined;
      }),
    );
    expect(nonces.map(String).sort()).toEqual(['0', '1', '2', '3', '4']);
    const finals = await mineWhile(
      env,
      Promise.all(subs.map((sub) => sub.wait({ finality: 'final' }))),
    );
    for (const final of finals) {
      expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
    }
    expect(env.chain.nonce(env.address)).toBe(5n);
  });

  // Review Focus 4: a secret in a provider URL never leaks through errors, events or logs.
  it('never leaks a provider secret through errors, events, logs or the handle', async () => {
    const clock = new FakeClock();
    // The health probes pass, so the read itself reaches the node and fails with a cause
    // that embeds the secret URL.
    const fake = new FakeFetch().route('https://node.test', (request) => {
      const { method } = request.json<{ method: string }>();
      if (method === 'fake_identity') return rpcResult(request, 'fake-local');
      if (method === 'fake_blockNumber') return rpcResult(request, '0');
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED https://node.test/v1/sk_live_E2ESECRET'),
      });
    });
    const logs: unknown[] = [];
    const aio = new CryptoAio({
      env: false,
      clock,
      logger: createLogger('e2e', (...record) => logs.push(record)),
      plugins: [fakePlugin()],
      transport: { fetch: fake.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 1_000 },
      providers: {
        node: {
          endpoints: [
            {
              name: 'main',
              url: secret('https://node.test/v1/sk_live_E2ESECRET'),
              headers: { authorization: secret('Bearer E2ETOKEN') },
            },
          ],
        },
      },
      chains: { fakechain: { provider: 'node' } },
    });
    const events: unknown[] = [];
    aio.onAny((event) => events.push(event));
    const bc = aio.blockchain({ chain: 'fakechain' });
    const error = await drive(clock, bc.getBlock(1n)).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringContaining('ECONNREFUSED <node/main>'),
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'rpc.error' }));
    const deep = { depth: Infinity, showHidden: true };
    for (const text of [
      inspect(error, deep),
      JSON.stringify(error),
      inspect(events, deep),
      inspect(logs, deep),
      inspect(bc, deep),
      inspect(bc.config, deep),
      JSON.stringify(bc.config),
    ]) {
      expect(text).not.toContain('E2ESECRET');
      expect(text).not.toContain('E2ETOKEN');
    }
  });

  it('recovers after restart({ killPrevious: true }) and scans from a durable cursor', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer, stores: { operations: faulty } });
    const recipient = env.stranger();
    // The process dies right after persisting the signed Attempt, before broadcasting it.
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(
        env.bc.transfer({ to: recipient, amount: 7n }, { idempotencyKey: 'crash' }),
      ),
    ).rejects.toBeInstanceOf(CrashError);

    const restarted = await env.restart({ killPrevious: true });
    expect(await restarted.run(restarted.aio.operations.recover())).toMatchObject({
      rebroadcast: 1,
      failed: 0,
    });
    const [operation] = await restarted.run(restarted.aio.operations.list());
    const final = await mineWhile(
      restarted,
      restarted.bc.waitForConfirmation(operation?.id ?? '', { finality: 'final' }),
    );
    expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
    expect(calls()).toBe(1); // never signed twice
    expect(restarted.chain.balance(recipient)).toBe(7n);

    const scanner = restarted.bc
      .scanner({ cursorKey: 'deposits', from: 1n, filter: { addresses: [recipient] } })
      [Symbol.asyncIterator]();
    let deposit: (ScanEvent & { type: 'block' }) | undefined;
    for (let i = 0; i < 10 && !deposit; i++) {
      const event = await take(restarted, scanner);
      await event.ack();
      if (event.type === 'block' && event.transactions.length > 0) deposit = event;
    }
    expect(deposit?.transactions[0]?.transfers[0]).toMatchObject({
      to: { canonical: recipient },
      amount: { base: 7n },
    });

    // Another crash: the next process resumes right after the acknowledged block.
    const next = await restarted.restart({ killPrevious: true });
    const resumed = next.bc
      .scanner({ cursorKey: 'deposits', from: 1n })
      [Symbol.asyncIterator]();
    expect(await take(next, resumed)).toMatchObject({
      type: 'block',
      block: { height: (deposit?.block.height ?? 0n) + 1n },
    });
  });

  it('hands out a per-handle native client and checks the library', async () => {
    const env = await createFakeEnv();
    const client = await env.run(native(env.bc, 'fake-sdk'));
    expect(await env.run(native(env.bc, 'fake-sdk'))).toBe(client);
    expect(await env.run(native(env.bc.with({ confirmations: 3 }), 'fake-sdk'))).not.toBe(
      client,
    );
    expect(await env.run(client.rpc<string>('fake_blockNumber'))).toBe('0');
    await expect(native(env.bc, 'ethers' as 'fake-sdk')).rejects.toMatchObject({
      code: 'INCOMPATIBLE_SELECTION',
    });
  });
});

// The store contract suites run from the public testing entry against the public stores.
describeCursorStoreContract({ describe, it }, () => ({
  cursors: new MemoryCursorStore(),
}));
