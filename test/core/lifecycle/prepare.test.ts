import { containerOf } from '../../../src/core/container/internals';
import { StateError } from '../../../src/core/errors/error';
import { createLogger, type LogLevel } from '../../../src/core/events/logger';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import type { AioEvent } from '../../../src/core/events/types';
import { MemoryLockManager, MemoryOperationStore } from '../../../src/core/store/memory';
import type { LockManager, OperationStore } from '../../../src/core/store/types';
import { createFakeEnv } from '../../../src/testing/env';
import { FakeClock } from '../../../src/testing/fake-clock';

const reservationOf = async (
  env: Awaited<ReturnType<typeof createFakeEnv>>,
  id: string,
) => (await env.stores.operations.get('default', id))?.reservation;

describe('prepareTransfer', () => {
  it('reserves a nonce and exposes the signing requests', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const prepared = await env.run(
      env.bc.prepareTransfer(
        { to: recipient, amount: '0.0000001' },
        { idempotencyKey: 'p-1' },
      ),
    );
    expect(prepared.operation.state).toBe('prepared');
    expect(prepared.unsigned?.signingRequests).toHaveLength(1);
    expect(prepared.unsigned?.fee.charges[0]?.amount.base).toBe(2n);
    expect(await reservationOf(env, prepared.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    const second = await env.run(
      env.bc.prepareTransfer({ to: recipient, amount: 5n }, { idempotencyKey: 'p-2' }),
    );
    expect(await reservationOf(env, second.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
  });

  // Review Focus 2: the same intent in another input form is an idempotent repeat, not a conflict.
  it('returns the same operation for an idempotent repeat in any input form', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const first = await env.run(
      env.bc.prepareTransfer(
        { to: recipient, amount: '0.0000001' },
        { idempotencyKey: 'same' },
      ),
    );
    const again = await env.run(
      env.bc.prepareTransfer(
        { to: recipient.toUpperCase().replace('FK1', 'fk1'), amount: 10n },
        { idempotencyKey: 'same' },
      ),
    );
    expect(again.operation.id).toBe(first.operation.id);
    await expect(
      env.run(
        env.bc.prepareTransfer(
          { to: recipient, amount: 11n },
          { idempotencyKey: 'same' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('abandons pre-signing operations and releases their nonce', async () => {
    const env = await createFakeEnv();
    const a = await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    expect((await env.run(env.bc.abandon(a.operation.id))).state).toBe('abandoned');
    await expect(env.run(env.bc.abandon(a.operation.id))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    const b = await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    expect(await reservationOf(env, b.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  // R22: every issued ticket is cancelled through the signer that issued it.
  it('cancels each signer ticket through its issuer when abandoning', async () => {
    const cancelled: string[] = [];
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'inner' }).signer;
    // A plain object: the fake env's generation proxy cannot wrap a frozen callbackSigner.
    const custody = (id: string, failing: boolean): Signer => ({
      id,
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async () => ({ status: 'pending' }),
      cancelRequest: async (ticket) => {
        cancelled.push(`${id}:${ticket}`);
        if (failing) throw new Error('custody backend unreachable');
      },
    });
    const env = await createFakeEnv({
      signer: custody('hot', true),
      aio: { signers: { mpc: custody('mpc', false) } },
    });
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const id = prepared.operation.id;
    const record = await env.stores.operations.get('default', id);
    if (!record) throw new Error('unreachable');
    const signerTickets = [
      { signerId: 'hot', ticket: 't-1' },
      { signerId: 'mpc', ticket: 't-2' },
    ];
    await env.stores.operations.update('default', id, { signerTickets }, record.version);
    expect((await env.run(env.bc.abandon(id))).state).toBe('abandoned');
    expect(cancelled).toEqual(['hot:t-1', 'mpc:t-2']);
    expect(
      (await env.stores.operations.get('default', id))?.signerTickets,
    ).toBeUndefined();
  });

  it('refuses to abandon an operation through a handle for another wallet', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const cold = env.aio
      .scope({ wallets: { cold: { address: env.stranger() } } })
      .blockchain({ chain: 'fakechain', wallet: 'cold' });
    await expect(env.run(cold.abandon(prepared.operation.id))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    expect(
      (await env.stores.operations.get('default', prepared.operation.id))?.state,
    ).toBe('prepared');
    expect((await env.run(env.bc.abandon(prepared.operation.id))).state).toBe(
      'abandoned',
    );
  });

  // Carry-forward: the store does not guard transitions, so the engine must.
  it('never moves a terminal operation to another state', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    await env.run(env.bc.abandon(prepared.operation.id));
    const engine = containerOf(env.aio).engine();
    const record = await engine.require(prepared.operation.id);
    for (const state of ['created', 'prepared', 'failed'] as const) {
      await expect(engine.update(record, { state })).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
    }
    expect((await engine.require(prepared.operation.id)).version).toBe(record.version);
  });

  // Spec §8.1: an idempotent repeat of a terminal Operation returns it unchanged.
  it('returns an abandoned operation unchanged, without signing material, on a repeat', async () => {
    const env = await createFakeEnv();
    const intent = { to: env.stranger(), amount: 1n };
    const first = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'gone' }),
    );
    await env.run(env.bc.abandon(first.operation.id));
    const again = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'gone' }),
    );
    expect(again.operation).toMatchObject({ id: first.operation.id, state: 'abandoned' });
    expect(again.unsigned).toBeUndefined();
    expect(await env.stores.operations.list({ namespace: 'default' })).toHaveLength(1);
  });

  it('fails before signing on insufficient funds and releases the nonce', async () => {
    const env = await createFakeEnv({ fund: 5n });
    const intent = { to: env.stranger(), amount: 100n };
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'poor' })),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '102', available: '5' },
    });
    expect((await env.stores.operations.getByKey('default', 'poor'))?.state).toBe(
      'failed',
    );
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'poor' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const ok = await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    expect(await reservationOf(env, ok.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  it('turns a policy veto into a failed operation and releases the nonce', async () => {
    const env = await createFakeEnv({
      hooks: {
        beforeSign: (ctx) => {
          if (ctx.summary.outputs[0]?.amount === '999') throw new Error('over the limit');
        },
      },
    });
    await expect(
      env.run(
        env.bc.prepareTransfer(
          { to: env.stranger(), amount: 999n },
          { idempotencyKey: 'big' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'over the limit',
    });
    expect((await env.stores.operations.getByKey('default', 'big'))?.state).toBe(
      'failed',
    );
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  it('keeps operations resumable after transient provider failures', async () => {
    const env = await createFakeEnv();
    const intent = { to: env.stranger(), amount: 1n };
    env.chain.configureEndpoint('main', { down: true });
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'flaky' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((await env.stores.operations.getByKey('default', 'flaky'))?.state).toBe(
      'created',
    );
    env.chain.configureEndpoint('main', { down: false });
    await env.clock.advance(30_000); // let the circuit breaker half-open
    const prepared = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'flaky' }),
    );
    expect(prepared.operation.state).toBe('prepared');
    expect(await reservationOf(env, prepared.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  // Crash consistency: the write may have landed, so its reservation must stay reserved.
  it('runs no compensation once the prepared write was attempted', async () => {
    const inner = new MemoryOperationStore(new FakeClock());
    let dropAck = true;
    const operations = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'update') {
          return async (...args: Parameters<OperationStore['update']>) => {
            const saved = await target.update(...args);
            if (dropAck && args[2].state === 'prepared') {
              dropAck = false;
              throw new Error('connection reset after commit');
            }
            return saved;
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const env = await createFakeEnv({ stores: { operations } });
    await expect(
      env.run(
        env.bc.prepareTransfer(
          { to: env.stranger(), amount: 1n },
          { idempotencyKey: 'lost-ack' },
        ),
      ),
    ).rejects.toThrow('connection reset after commit');
    const record = await env.stores.operations.getByKey('default', 'lost-ack');
    expect(record).toMatchObject({
      state: 'prepared',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
  });

  it('validates intents before creating any operation', async () => {
    const env = await createFakeEnv();
    await expect(
      env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 0n })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      env.run(
        env.bc.prepareTransfer({
          outputs: [
            { to: env.stranger(), amount: 1n },
            { to: env.stranger(), amount: 1n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      env.run(
        env.bc.prepareTransfer({ to: env.stranger(), amount: 1n, from: env.stranger() }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      env.run(env.bc.prepareTransfer({ to: 'nope', amount: 1n })),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(await env.stores.operations.list({ namespace: 'default' })).toHaveLength(0);
  });

  it('requires idempotency keys when configured', async () => {
    const env = await createFakeEnv({ lifecycle: { requireIdempotencyKey: true } });
    await expect(
      env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n })),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('exposes operation views without payloads or signing material', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const view = await env.run(env.bc.getOperation(prepared.operation.id));
    expect(view).toMatchObject({
      state: 'prepared',
      chain: 'fakechain',
      network: 'local',
      attempts: [],
      ambiguous: false,
    });
    expect(JSON.stringify(view)).not.toContain(
      prepared.unsigned?.payload.data.slice(0, 24) ?? '###',
    );
    expect(await env.run(env.bc.getOperation('op_missing'))).toBeNull();
  });

  // Carry-forward: IntentSummary (addresses, amounts) never reaches an event payload.
  it('emits operational events only, never addresses or amounts', async () => {
    const env = await createFakeEnv({ fund: 10n ** 12n });
    const events: AioEvent[] = [];
    env.aio.onAny((event) => events.push(event));
    const recipient = env.stranger();
    await env.run(
      env.bc.prepareTransfer(
        { to: recipient, amount: 123_456_789n },
        { idempotencyKey: 'ev' },
      ),
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['operation.state', 'nonce.allocated']),
    );
    const text = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const secret of [recipient, env.address, '123456789', '1.23456789'])
      expect(text).not.toContain(secret);
  });

  // Carry-forward (Task 22): a failed best-effort lease release is logged by code only.
  it('logs only the error code when an address lease release fails', async () => {
    const logs: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] =
      [];
    const inner = new MemoryLockManager(new FakeClock());
    const locks: LockManager = {
      acquire: (key, owner, ttlMs) => inner.acquire(key, owner, ttlMs),
      renew: (lease, ttlMs) => inner.renew(lease, ttlMs),
      release: async (lease) => {
        await inner.release(lease);
        throw new StateError('FENCING', `store detail for ${lease.key}`);
      },
    };
    const env = await createFakeEnv({
      stores: { locks },
      aio: {
        logger: createLogger('test', (level, _ns, message, fields) =>
          logs.push({ level, message, ...(fields ? { fields } : {}) }),
        ),
      },
    });
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(prepared.operation.state).toBe('prepared');
    expect(logs.filter((entry) => entry.message === 'lease release failed')).toEqual([
      { level: 'warn', message: 'lease release failed', fields: { code: 'FENCING' } },
    ]);
  });
});
