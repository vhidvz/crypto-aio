import { internalsOf } from '../../../src/core/blockchain/internal';
import { containerOf } from '../../../src/core/container/internals';
import { StateError } from '../../../src/core/errors/error';
import { createLogger, type LogLevel } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import { intentHash } from '../../../src/core/model/intent';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import {
  MemoryLockManager,
  MemoryOperationStore,
  MemorySequenceStore,
  createMemoryStores,
} from '../../../src/core/store/memory';
import type {
  LockManager,
  OperationState,
  OperationStore,
  SequenceState,
  SequenceStore,
} from '../../../src/core/store/types';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';
import { FakeClock } from '../../../src/testing/fake-clock';

const reservationOf = async (env: FakeEnv, id: string) =>
  (await env.stores.operations.get('default', id))?.reservation;

const walletSequenceKey = (env: FakeEnv) =>
  sequenceKey('default', 'fakechain', 'local', env.address);

function captureLogs() {
  const logs: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] =
    [];
  const logger = createLogger('test', (level, _ns, message, fields) =>
    logs.push({ level, message, ...(fields ? { fields } : {}) }),
  );
  return { logs, logger };
}

/** An operation store that commits the first `prepared` write, then loses its ack. */
function lostAckOperations(): OperationStore {
  const inner = new MemoryOperationStore(new FakeClock());
  let dropAck = true;
  return new Proxy(inner, {
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
}

/** A sequence store that runs `beforePut` (which may throw) ahead of every write. */
function scriptedSequences(
  beforePut: (state: Omit<SequenceState, 'version'>) => Promise<void> | void,
): SequenceStore {
  const inner = new MemorySequenceStore();
  return {
    get: (key) => inner.get(key),
    put: async (key, state, expectedVersion) => {
      await beforePut(state);
      await inner.put(key, state, expectedVersion);
    },
  };
}

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

  // The same intent in another input form (a bigint instead of a decimal string, another
  // address casing) is an idempotent repeat, not a conflict.
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

  // Abandon waits for the address lease, so it cannot slip in between a resumed
  // prepare's allocation and its persisted reservation.
  it('never leaks the nonce when abandon races a resumed prepare', async () => {
    let onAllocate: (() => Promise<void>) | undefined;
    const sequences = scriptedSequences(async () => {
      const hook = onAllocate;
      onAllocate = undefined;
      await hook?.();
    });
    const env = await createFakeEnv({ stores: { sequences } });
    const intent = { to: env.stranger(), amount: 1n };
    env.chain.configureEndpoint('main', { down: true });
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'race' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const created = await env.stores.operations.getByKey('default', 'race');
    if (!created) throw new Error('unreachable');
    env.chain.configureEndpoint('main', { down: false });
    await env.clock.advance(30_000);
    let abandoning: Promise<unknown> | undefined;
    onAllocate = async () => {
      abandoning = env.bc.abandon(created.id);
      await env.clock.sleep(1_000);
    };
    await env.run(
      Promise.allSettled([env.bc.prepareTransfer(intent, { idempotencyKey: 'race' })]),
    );
    await env.run(Promise.allSettled([abandoning]));
    expect(abandoning).toBeDefined();
    expect((await env.stores.operations.get('default', created.id))?.state).toBe(
      'abandoned',
    );
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  // A veto from a hook that outlives the address lease writes nothing, so the
  // nonce is never lost; the veto is retried on the next repeat under a fresh lease.
  it('keeps the nonce when a slow veto outlives the address lease', async () => {
    let lingering = true;
    const { logs, logger } = captureLogs();
    const env: FakeEnv = await createFakeEnv({
      aio: { logger },
      hooks: {
        beforeSign: async (ctx) => {
          if (ctx.summary.outputs[0]?.amount !== '999') return;
          if (lingering) await env.clock.sleep(40_000); // leaseMs is 30s
          throw new Error('vetoed late');
        },
      },
    });
    const slowIntent = { to: env.stranger(), amount: 999n };
    const slow = env.bc.prepareTransfer(slowIntent, { idempotencyKey: 'slow' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await env.run(env.clock.sleep(10_000));
    const second = await env.run(
      env.bc.prepareTransfer(
        { to: env.stranger(), amount: 1n },
        { idempotencyKey: 'second' },
      ),
    );
    expect(await reservationOf(env, second.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
    expect(await env.run(slow)).toMatchObject({ code: 'POLICY_REJECTED' });
    expect((await env.stores.operations.getByKey('default', 'slow'))?.state).toBe(
      'prepared',
    );
    lingering = false;
    await expect(
      env.run(env.bc.prepareTransfer(slowIntent, { idempotencyKey: 'slow' })),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect((await env.stores.operations.getByKey('default', 'slow'))?.state).toBe(
      'failed',
    );
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    expect(
      logs.filter((entry) => entry.message === 'reservation release failed'),
    ).toEqual([]);
    const slowId = (await env.stores.operations.getByKey('default', 'slow'))?.id;
    expect(
      logs.filter(
        (entry) => entry.message === 'address lease lost before a terminal write',
      ),
    ).toEqual([
      {
        level: 'warn',
        message: 'address lease lost before a terminal write',
        fields: { operationId: slowId, code: 'FENCING' },
      },
    ]);
  });

  // The policy hook of prepare() is bounded by lifecycle.signTimeoutMs, like signing.
  it('stops waiting for a hung policy hook after signTimeoutMs and fails nothing', async () => {
    let hung = true;
    const env = await createFakeEnv({
      lifecycle: { signTimeoutMs: 5_000 },
      hooks: {
        beforeSign: () => (hung ? new Promise<void>(() => undefined) : undefined),
      },
    });
    const intent = { to: env.stranger(), amount: 3n };
    const started = env.clock.now();
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'hung' })),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(env.clock.now() - started).toBeLessThanOrEqual(6_000);
    expect(await env.stores.operations.getByKey('default', 'hung')).toMatchObject({
      state: 'prepared',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    hung = false;
    const repeat = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'hung' }),
    );
    expect(repeat.operation.state).toBe('prepared');
  });

  // Lease contention fails abandon before any write, so a retry succeeds.
  it('lets abandon be retried after it lost the address lease to contention', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const held = await env.stores.locks.acquire(
      walletSequenceKey(env),
      'intruder',
      600_000,
    );
    if (!held) throw new Error('unreachable');
    await expect(env.run(env.bc.abandon(prepared.operation.id))).rejects.toMatchObject({
      code: 'SEQUENCE_BUSY',
    });
    expect(
      (await env.stores.operations.get('default', prepared.operation.id))?.state,
    ).toBe('prepared');
    await env.stores.locks.release(held);
    expect((await env.run(env.bc.abandon(prepared.operation.id))).state).toBe(
      'abandoned',
    );
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  // Every issued ticket is cancelled through the signer that issued it (failures and
  // unresolvable signers are logged by code only).
  it('cancels each signer ticket through its issuer when abandoning', async () => {
    const cancelled: string[] = [];
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'inner' }).signer;
    const custody = (id: string, failing: boolean) =>
      callbackSigner({
        id,
        schemes: ['secp256k1-ecdsa'],
        getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
        sign: async () => ({ status: 'pending' }),
        cancelRequest: async (ticket) => {
          cancelled.push(`${id}:${ticket}`);
          if (failing) throw new Error(`custody backend for ${env.address} unreachable`);
        },
      });
    const { logs, logger } = captureLogs();
    const env = await createFakeEnv({
      signer: custody('hot', true),
      aio: { signers: { mpc: custody('mpc', false) }, logger },
    });
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const id = prepared.operation.id;
    const record = await env.stores.operations.get('default', id);
    if (!record) throw new Error('unreachable');
    const signerTickets = [
      { signerId: 'hot', ticket: 't-1' },
      { signerId: 'gone', ticket: 't-3' },
      { signerId: 'mpc', ticket: 't-2' },
    ];
    await env.stores.operations.update('default', id, { signerTickets }, record.version);
    expect((await env.run(env.bc.abandon(id))).state).toBe('abandoned');
    expect(cancelled).toEqual(['hot:t-1', 'mpc:t-2']);
    expect(
      (await env.stores.operations.get('default', id))?.signerTickets,
    ).toBeUndefined();
    expect(
      logs.filter((entry) => entry.message === 'signer cancelRequest failed'),
    ).toEqual([
      {
        level: 'warn',
        message: 'signer cancelRequest failed',
        fields: { operationId: id, signerId: 'hot', code: 'UNKNOWN' },
      },
      {
        level: 'warn',
        message: 'signer cancelRequest failed',
        fields: { operationId: id, signerId: 'gone', code: 'SIGNER_UNAVAILABLE' },
      },
    ]);
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

  // The store does not guard transitions, so the engine must.
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

  // An idempotent repeat of a terminal Operation returns it unchanged.
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
    const env = await createFakeEnv({ stores: { operations: lostAckOperations() } });
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

  // A repeat of an Operation left `prepared` (lost ack) still runs the policy veto.
  it('runs the veto again when repeating an operation left prepared', async () => {
    let vetoing = true;
    const env = await createFakeEnv({
      stores: { operations: lostAckOperations() },
      hooks: {
        beforeSign: () => {
          if (vetoing) throw new Error('frozen by compliance');
        },
      },
    });
    const intent = { to: env.stranger(), amount: 1n };
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'held' })),
    ).rejects.toThrow('connection reset after commit');
    expect((await env.stores.operations.getByKey('default', 'held'))?.state).toBe(
      'prepared',
    );
    await expect(
      env.run(env.bc.prepareTransfer(intent, { idempotencyKey: 'held' })),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect((await env.stores.operations.getByKey('default', 'held'))?.state).toBe(
      'failed',
    );
    vetoing = false;
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  // A veto whose release fails still surfaces the veto; the release is logged by code.
  it('surfaces the veto, not the release failure, when the nonce cannot be released', async () => {
    const { logs, logger } = captureLogs();
    const sequences = scriptedSequences((state) => {
      if (state.released.length > 0) {
        throw new StateError(
          'VERSION_CONFLICT',
          'the sequence was modified concurrently',
        );
      }
    });
    const env = await createFakeEnv({
      stores: { sequences },
      hooks: {
        beforeSign: () => {
          throw new Error('over the limit');
        },
      },
      aio: { logger },
    });
    await expect(
      env.run(
        env.bc.prepareTransfer(
          { to: env.stranger(), amount: 1n },
          { idempotencyKey: 'veto' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED', message: 'over the limit' });
    const record = await env.stores.operations.getByKey('default', 'veto');
    expect(record?.state).toBe('failed');
    expect(
      logs.filter((entry) => entry.message === 'reservation release failed'),
    ).toEqual([
      {
        level: 'warn',
        message: 'reservation release failed',
        fields: { operationId: record?.id, code: 'VERSION_CONFLICT' },
      },
    ]);
  });

  // The persisted reservation must be the slot that was allocated.
  it('fails and releases when the built transaction uses another nonce', async () => {
    const env = await createFakeEnv();
    const { driver } = await internalsOf(env.bc).pooled();
    const build = driver.builder.build.bind(driver.builder);
    const spy = jest
      .spyOn(driver.builder, 'build')
      .mockImplementationOnce((intent, fee, ctx) =>
        build(intent, fee, { ...ctx, ordering: { kind: 'nonce', nonce: 7n } }),
      );
    await expect(
      env.run(
        env.bc.prepareTransfer(
          { to: env.stranger(), amount: 1n },
          { idempotencyKey: 'skewed' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    spy.mockRestore();
    const record = await env.stores.operations.getByKey('default', 'skewed');
    expect(record?.state).toBe('failed');
    expect(record?.reservation).toBeUndefined();
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await reservationOf(env, next.operation.id)).toEqual({
      kind: 'nonce',
      nonce: 0n,
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

  // Like getTransactionStatus, a handle only shows Operations of its chain and network.
  it('refuses to show an operation of another chain or network', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const other = env.aio.blockchain({ chain: 'fakeexpiry', provider: 'fake' });
    await expect(
      env.run(other.getOperation(prepared.operation.id)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    expect(await env.run(other.getOperation('op_missing'))).toBeNull();
  });

  // IntentSummary (addresses, amounts) never reaches an event payload.
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

  // A failed best-effort lease release is logged by code only.
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

// Invariants that already held, pinned so a regression cannot pass unnoticed.
describe('prepare and abandon invariants', () => {
  it('turns concurrent calls with one key into one operation and one reservation', async () => {
    const env = await createFakeEnv();
    const intent = { to: env.stranger(), amount: 1n };
    const results = await env.run(
      Promise.all(
        [1, 2, 3].map(() => env.bc.prepareTransfer(intent, { idempotencyKey: 'dup' })),
      ),
    );
    expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
    expect(await env.stores.operations.list({ namespace: 'default' })).toHaveLength(1);
    expect(await env.stores.sequences.get(walletSequenceKey(env))).toMatchObject({
      next: 1n,
      released: [],
    });
  });

  it('keeps idempotency keys and reservations independent per namespace', async () => {
    const stores = createMemoryStores(new FakeClock());
    const signer = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
    const a = await createFakeEnv({ stores, signer });
    const b = await createFakeEnv({ stores, signer, aio: { namespace: 'tenant-b' } });
    expect(b.address).toBe(a.address);
    const first = await a.run(
      a.bc.prepareTransfer({ to: a.stranger(), amount: 1n }, { idempotencyKey: 'k' }),
    );
    const second = await b.run(
      b.bc.prepareTransfer({ to: b.stranger(), amount: 2n }, { idempotencyKey: 'k' }),
    );
    expect(second.operation.id).not.toBe(first.operation.id);
    for (const namespace of ['default', 'tenant-b']) {
      expect((await stores.operations.getByKey(namespace, 'k'))?.reservation).toEqual({
        kind: 'nonce',
        nonce: 0n,
      });
    }
  });

  it('treats a memo, fee, recipient or amount change under one key as a conflict', async () => {
    const env = await createFakeEnv();
    const to = env.stranger();
    const base = { to, amount: 1n };
    const first = await env.run(env.bc.prepareTransfer(base, { idempotencyKey: 'k' }));
    const same = await env.run(
      env.bc.prepareTransfer(
        { outputs: [{ to, amount: '0.00000001' }] },
        { idempotencyKey: 'k' },
      ),
    );
    expect(same.operation.id).toBe(first.operation.id);
    for (const variant of [
      { ...base, memo: 'invoice-7' },
      { ...base, fee: 'fast' as const },
      { ...base, to: env.stranger() },
      { ...base, amount: 2n },
    ]) {
      await expect(
        env.run(env.bc.prepareTransfer(variant, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    // The fake chain has no tokens, so the asset is pinned at the hash the engine compares.
    const stored = (await env.stores.operations.getByKey('default', 'k'))?.intent;
    if (!stored) throw new Error('unreachable');
    expect(
      intentHash('fakechain', 'local', {
        ...stored,
        assetId: 'fakechain:local:token:0xabc',
      }),
    ).not.toBe(intentHash('fakechain', 'local', stored));
  });

  it('emits failure transitions with codes only, never messages, addresses or amounts', async () => {
    const env = await createFakeEnv({
      fund: 1_000n,
      hooks: {
        beforeSign: (ctx) => {
          if (ctx.summary.outputs[0]?.amount === '777') throw new Error('over the limit');
        },
      },
    });
    const events: AioEvent[] = [];
    env.aio.onAny((event) => events.push(event));
    const poorTo = env.stranger();
    const vetoTo = env.stranger();
    await expect(
      env.run(env.bc.prepareTransfer({ to: poorTo, amount: 123_456n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      env.run(env.bc.prepareTransfer({ to: vetoTo, amount: 777n })),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    const failed = events.filter(
      (e) => e.type === 'operation.state' && e.to === 'failed',
    );
    expect(
      failed.map((e) => (e.type === 'operation.state' ? e.code : undefined)),
    ).toEqual(['INSUFFICIENT_FUNDS', 'POLICY_REJECTED']);
    const text = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const secret of [
      poorTo,
      vetoTo,
      env.address,
      '123456',
      'insufficient funds',
      'over the limit',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses to abandon signed and later states, and abandons awaiting-signature', async () => {
    const env = await createFakeEnv();
    const later = [
      'signed',
      'submitted',
      'stalled',
      'included',
      'final',
      'failed',
      'expired',
    ];
    for (const state of later as OperationState[]) {
      const { operation } = await env.run(
        env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
      );
      const record = await env.stores.operations.get('default', operation.id);
      if (!record) throw new Error('unreachable');
      await env.stores.operations.update(
        'default',
        operation.id,
        { state },
        record.version,
      );
      await expect(env.run(env.bc.abandon(operation.id))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
      expect((await env.stores.operations.get('default', operation.id))?.state).toBe(
        state,
      );
    }
    const { operation } = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const record = await env.stores.operations.get('default', operation.id);
    if (!record) throw new Error('unreachable');
    await env.stores.operations.update(
      'default',
      operation.id,
      { state: 'awaiting-signature' },
      record.version,
    );
    const reserved = record.reservation;
    if (reserved?.kind !== 'nonce') throw new Error('unreachable');
    expect((await env.run(env.bc.abandon(operation.id))).state).toBe('abandoned');
    // Its nonce goes back for reuse. (Each prepare above also reclaims the values of
    // the forced 'failed' and 'expired' Operations, which consumed nothing, so the exact
    // values depend on the loop.)
    expect((await env.stores.sequences.get(walletSequenceKey(env)))?.released).toContain(
      reserved.nonce,
    );
  });

  it('allows same-state and state-less updates on a terminal operation', async () => {
    const env = await createFakeEnv();
    const { operation } = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    await env.run(env.bc.abandon(operation.id));
    const engine = containerOf(env.aio).engine();
    const abandoned = await engine.require(operation.id);
    const touched = await engine.update(abandoned, { nextCheckAt: 5 });
    expect(touched).toMatchObject({ state: 'abandoned', nextCheckAt: 5 });
    const same = await engine.update(touched, {
      state: 'abandoned',
      clear: ['nextCheckAt'],
    });
    expect(same.state).toBe('abandoned');
    expect(same.version).toBe(abandoned.version + 2);
  });
});
