import { internalsOf } from '../../../src/core/blockchain/internal';
import { containerOf } from '../../../src/core/container/internals';
import { ChainError } from '../../../src/core/errors/error';
import { noopLogger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import {
  withLifecycleDefaults,
  type OperationTarget,
} from '../../../src/core/lifecycle/engine';
import { Monitor } from '../../../src/core/lifecycle/monitor';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import {
  MemoryOperationStore,
  MemorySequenceStore,
} from '../../../src/core/store/memory';
import type {
  AttemptRecord,
  Fence,
  OperationPatch,
  OperationRecord,
  SequenceState,
  SequenceStore,
} from '../../../src/core/store/types';
import type { Transport } from '../../../src/core/transport/types';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner, mineWhile } from './support';

describe('background workers', () => {
  it('finalizes operations without anyone waiting and stops on abort', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ctl = new AbortController();
    const worker = env.aio.monitor.start({ workerId: 'w1', signal: ctl.signal });
    for (let i = 0; i < 20; i++) {
      env.chain.mine();
      await env.clock.advance(1_000);
    }
    expect((await env.stores.operations.get('default', sub.operationId))?.state).toBe(
      'final',
    );
    ctl.abort();
    await env.clock.advance(1_000);
    await expect(worker).resolves.toBeUndefined();
  });

  it('processes each due operation once per poll interval across workers', async () => {
    const env = await createFakeEnv();
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const other = await env.restart();
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'a' }))).toBe(1);
    expect(await other.run(other.aio.monitor.runOnce({ workerId: 'b' }))).toBe(0);
    await env.clock.advance(1_000);
    expect(await other.run(other.aio.monitor.runOnce({ workerId: 'b' }))).toBe(1);
  });

  it('recovers signed operations by rebroadcasting and reports those that need a caller', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ stores: { operations: faulty }, signer });
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'signed' }),
      ),
    ).rejects.toBeInstanceOf(CrashError);
    await env.run(
      env.bc.prepareTransfer(
        { to: env.stranger(), amount: 1n },
        { idempotencyKey: 'prepared' },
      ),
    );
    const restarted = await env.restart({ killPrevious: true });
    const skipped: AioEvent[] = [];
    restarted.aio.on('recovery.skipped', (e) => skipped.push(e));
    const signedBefore = calls();
    const report = await restarted.run(restarted.aio.operations.recover());
    expect(report).toMatchObject({ rebroadcast: 1, skipped: 1, failed: 0 });
    expect(calls()).toBe(signedBefore); // recovery never signs
    expect(skipped).toEqual([expect.objectContaining({ state: 'prepared' })]);
    // Codes and states only: no message, address or amount.
    expect(Object.keys(skipped[0] ?? {}).sort()).toEqual([
      'at',
      'namespace',
      'operationId',
      'reason',
      'state',
      'type',
    ]);
    expect((skipped[0] as AioEvent<'recovery.skipped'>).reason).toMatch(/^[A-Z_]+$/);
    // The old process died: its store handles never settle, so read through the new one.
    const signed = await restarted.stores.operations.getByKey('default', 'signed');
    expect(signed?.state).toBe('submitted');
    expect(env.chain.inMempool(signed?.attempts[0]?.ref.id ?? '')).toBe(true);
  });

  it('reports a nonce gap together with the blocking operation', async () => {
    const env = await createFakeEnv();
    const gaps: AioEvent[] = [];
    env.aio.on('nonce.gap', (e) => gaps.push(e));
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(
        env.bc.transfer(
          { to: env.stranger(), amount: 3n },
          { idempotencyKey: 'blocker' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    const blocked = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 'blocked' }),
    );
    await env.clock.advance(11_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    const blocker = await env.stores.operations.getByKey('default', 'blocker');
    expect(gaps).toEqual([
      expect.objectContaining({
        operationId: blocked.operationId,
        expected: '0',
        blockingOperationId: blocker?.id,
      }),
    ]);
    // Reconciliation never returns a value a live Operation (the stalled blocker) holds.
    expect(await sequenceOf(env)).toMatchObject({ next: 2n, released: [] });
    await env.clock.advance(1_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    expect(gaps).toHaveLength(1);
  });

  it('lists operations as views filtered by state', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    expect(
      (await env.aio.operations.list({ states: ['prepared'] })).map((v) => v.state),
    ).toEqual(['prepared']);
    expect(await env.aio.operations.list()).toHaveLength(2);
    expect(await env.aio.operations.get(sub.operationId)).toMatchObject({
      id: sub.operationId,
      state: 'submitted',
      attempts: [expect.objectContaining({ status: expect.any(Object) })],
    });
    expect(await env.aio.operations.get('op_missing')).toBeNull();
  });
});

describe('workers schedule every pass they make (R26)', () => {
  it('reschedules an operation whose check throws instead of spinning on it', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    env.chain.configureEndpoint('main', { down: true });
    const started = env.clock.now();
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(1);
    const op = await stored(env, sub.operationId);
    expect(op.state).toBe('submitted');
    expect(op.claim).toBeUndefined();
    expect(op.nextCheckAt).toBeGreaterThanOrEqual(started + 1_000);
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(0);
  });

  it('schedules the next check after a stale-view pass that decided nothing', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const real = await targetOf(env);
    const stale: OperationTarget = {
      ...real,
      pooled: { ...real.pooled, transport: withHighest(real.pooled.transport, 1_000n) },
    };
    const monitor = monitorWith(env, async () => stale);
    env.chain.mine();
    const started = env.clock.now();
    expect(await env.run(monitor.runOnce({ workerId: 'w' }))).toBe(1);
    const op = await stored(env, sub.operationId);
    expect(op.state).toBe('submitted'); // a stale view decides nothing
    expect(op.nextCheckAt).toBeGreaterThanOrEqual(started + 1_000);
    expect(await env.run(monitor.runOnce({ workerId: 'w' }))).toBe(0);
  });

  it('schedules the next check when the all-rejected verdict could not run', async () => {
    const { env, op } = await rejectedButLive();
    await env.stores.locks.acquire(leaseKey(env), 'elsewhere', 600_000);
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(1);
    const after = await stored(env, op.id);
    expect(after.state).toBe('signed');
    expect(after.claim).toBeUndefined();
    expect(after.nextCheckAt).toBeGreaterThan(env.clock.now());
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(0);
  });

  it('rebuilds an operation target from its own named provider first', async () => {
    const env = await createFakeEnv();
    const scoped = env.aio.scope({
      providers: {
        side: { endpoints: [{ name: 'side', url: env.chain.endpoint('side') }] },
      },
    });
    const bc = scoped.blockchain({ chain: env.chainId, provider: 'side' });
    const sub = await env.run(bc.transfer({ to: env.stranger(), amount: 1n }));
    env.chain.configureEndpoint('main', { down: true });
    env.chain.mine();
    expect(await env.run(scoped.monitor.runOnce({ workerId: 'w' }))).toBe(1);
    expect((await stored(env, sub.operationId)).state).toBe('included');
  });
});

describe('nonce reconciliation returns leaked values, never a live or consumed one', () => {
  it('returns a nonce leaked by a crash between allocation and the prepared write', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({ stores: { operations: faulty } });
    faulty.crashOn({
      method: 'update',
      timing: 'before',
      when: (args) => (args[2] as OperationPatch | undefined)?.state === 'prepared',
    });
    const intent = { to: env.stranger(), amount: 2n };
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'leak' })),
    ).rejects.toBeInstanceOf(CrashError);
    expect(await sequenceOf(env)).toMatchObject({ next: 1n, released: [] });
    const restarted = await env.restart({ killPrevious: true });
    const report = await restarted.run(restarted.aio.operations.recover());
    expect(report).toMatchObject({ skipped: 1, failed: 0, reconciled: 1 });
    expect(await sequenceOf(restarted)).toMatchObject({ next: 1n, released: [0n] });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'leak' }),
    );
    expect((await stored(restarted, sub.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    restarted.chain.mine();
    expect(restarted.chain.nonce(restarted.address)).toBe(1n);
  });

  it('returns a nonce whose release failed after a terminal write once a gap blocks a transfer', async () => {
    const sequences = new FailingReleaseStore();
    let veto = true;
    const env = await createFakeEnv({
      stores: { sequences },
      hooks: {
        beforeSign: () => {
          if (veto) throw new Error('vetoed');
        },
      },
    });
    const gaps: AioEvent[] = [];
    env.aio.on('nonce.gap', (e) => gaps.push(e));
    sequences.armed = true;
    await expect(
      env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n })),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(await sequenceOf(env)).toMatchObject({ next: 1n, released: [] });
    veto = false;
    const blocked = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, blocked.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
    await env.clock.advance(11_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    expect(gaps).toEqual([
      expect.objectContaining({ operationId: blocked.operationId, expected: '0' }),
    ]);
    expect(gaps[0]).not.toHaveProperty('blockingOperationId');
    expect(await sequenceOf(env)).toMatchObject({ next: 2n, released: [0n] });
    const filling = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, filling.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(2n);
  });

  it('returns a nonce a failure recorded without a release left, never one the chain consumed', async () => {
    const env = await createFakeEnv();
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await mineWhile(env, first.wait({ finality: 'final' }));
    expect((await stored(env, first.operationId)).state).toBe('final');
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 'lost' }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const lost = await env.stores.operations.getByKey('default', 'lost');
    if (!lost) throw new Error('unreachable');
    // A failure an earlier monitor recorded without releasing the nonce.
    await env.stores.operations.update(
      'default',
      lost.id,
      {
        state: 'failed',
        error: new ChainError('TX_REJECTED', 'rejected').toJSON(),
        clear: ['nextCheckAt'],
      },
      lost.version,
    );
    const blocked = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, blocked.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 2n,
    });
    const report = await env.run(env.aio.operations.recover());
    expect(report).toMatchObject({ failed: 0, reconciled: 1 });
    // 0 was consumed on chain (below chainPending); 2 is held by a live Operation.
    expect(await sequenceOf(env)).toMatchObject({ next: 3n, released: [1n] });
    const filling = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, filling.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(3n);
  });
});

describe('a lost append keeps its contract (Task 24 review)', () => {
  it('rethrows the conflict when the stored operation was not signed meanwhile', async () => {
    const operations = new RacingAppendStore();
    const env = await createFakeEnv({ stores: { operations } });
    const intent = { to: env.stranger(), amount: 1n };
    operations.race = { clear: ['error'] };
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const op = await env.stores.operations.getByKey('default', 'k');
    expect(op).toMatchObject({ state: 'prepared', attempts: [] });
    const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'k' }));
    expect((await stored(env, sub.operationId)).attempts).toHaveLength(1);
  });

  it('reports an operation abandoned meanwhile as an invalid transition', async () => {
    const operations = new RacingAppendStore();
    const env = await createFakeEnv({ stores: { operations } });
    operations.race = { state: 'abandoned' };
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 1n })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('reconciliation fences out a stale prepared write (R29)', () => {
  it('never lets a paused prepared write land on a nonce reconciliation released', async () => {
    const operations = new GatedUpdateStore();
    const { signer, signed } = recordingSigner();
    const env = await createFakeEnv({ stores: { operations }, signer });
    const intentA = { to: env.stranger(), amount: 1n };
    const gate = operations.gate((patch) => patch.state === 'prepared');
    const a = env.bc.transfer(intentA, { idempotencyKey: 'a' });
    a.catch(() => undefined);
    await env.run(gate.reached); // A allocated nonce 0 and renewed; its write is paused
    await env.clock.advance(31_000); // A's address lease (30 s) lapses
    const other = await env.restart(); // a second live process
    await other.run(other.aio.operations.recover());
    gate.release();
    await expect(env.run(a)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const opA = await other.stores.operations.getByKey('default', 'a');
    expect(opA).toMatchObject({ state: 'created' });
    expect(opA?.reservation).toBeUndefined();
    const b = await other.run(
      other.bc.transfer({ to: other.stranger(), amount: 1n }, { idempotencyKey: 'b' }),
    );
    expect((await stored(other, b.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    const again = await other.run(other.bc.transfer(intentA, { idempotencyKey: 'a' }));
    expect((await stored(other, again.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
    const nonces = await Promise.all(
      signed.map(async (id) => (await stored(other, id)).reservation),
    );
    expect(nonces).toEqual([
      { kind: 'nonce', nonce: 0n },
      { kind: 'nonce', nonce: 1n },
    ]);
  });

  it('holds a reservation that landed just before its fencing write', async () => {
    const operations = new RacingUpdateStore();
    const env = await createFakeEnv({ stores: { operations } });
    operations.race = (patch) => (patch.state === 'prepared' ? 'crash' : undefined);
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 'x' }),
      ),
    ).rejects.toBeInstanceOf(CrashError);
    // The stale prepared write lands between the listing and the fencing write.
    operations.race = (patch) =>
      patch.clear?.includes('error') && patch.state === undefined
        ? { state: 'prepared', reservation: { kind: 'nonce', nonce: 0n } }
        : undefined;
    const report = await env.run(env.aio.operations.recover());
    expect(report).toMatchObject({ failed: 0, reconciled: 0 });
    expect(await sequenceOf(env)).toMatchObject({ next: 1n, released: [] });
  });
});

// ---- helpers --------------------------------------------------------------------------

/** A local signer that records the Operation of every signing call. */
function recordingSigner(): { signer: Signer; signed: string[] } {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  const signed: string[] = [];
  const signer = callbackSigner({
    id: 'hot',
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      signed.push(ctx.operationId);
      return inner.sign(requests, ctx);
    },
  });
  return { signer, signed };
}

/**
 * Before the next `update` its `race` matches: `'crash'` fails it unwritten; a patch is
 * landed first by a racing writer (so the update loses its compare-and-set).
 */
class RacingUpdateStore extends MemoryOperationStore {
  race: ((patch: OperationPatch) => OperationPatch | 'crash' | undefined) | undefined;

  override async update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const decision = this.race?.(patch);
    if (decision !== undefined) this.race = undefined;
    if (decision === 'crash') throw new CrashError();
    const current = decision ? await this.get(namespace, id) : null;
    if (decision && current) await super.update(namespace, id, decision, current.version);
    return super.update(namespace, id, patch, expectedVersion, fence);
  }
}

/** Pauses the next `update` whose patch matches until `release()`: a slow store write. */
class GatedUpdateStore extends MemoryOperationStore {
  #gate:
    | {
        readonly matches: (patch: OperationPatch) => boolean;
        readonly reached: () => void;
        readonly opened: Promise<void>;
      }
    | undefined;

  gate(matches: (patch: OperationPatch) => boolean): {
    reached: Promise<void>;
    release: () => void;
  } {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const reachedP = new Promise<void>((resolve) => (reached = resolve));
    const opened = new Promise<void>((resolve) => (release = resolve));
    this.#gate = { matches, reached, opened };
    return { reached: reachedP, release };
  }

  override async update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const gate = this.#gate;
    if (gate?.matches(patch)) {
      this.#gate = undefined;
      gate.reached();
      await gate.opened;
    }
    return super.update(namespace, id, patch, expectedVersion, fence);
  }
}

async function stored(env: FakeEnv, operationId: string): Promise<OperationRecord> {
  const op = await env.stores.operations.get('default', operationId);
  if (!op) throw new Error(`operation ${operationId} not found`);
  return op;
}

function leaseKey(env: FakeEnv): string {
  return sequenceKey('default', env.chainId, 'local', env.address);
}

function sequenceOf(env: FakeEnv): Promise<SequenceState | null> {
  return env.stores.sequences.get(leaseKey(env));
}

async function targetOf(env: FakeEnv): Promise<OperationTarget> {
  const internals = internalsOf(env.bc);
  return {
    selection: internals.selection,
    pooled: await internals.pooled(),
    wallet: await internals.wallet(),
    assets: containerOf(env.aio).runtime.assets,
  };
}

/** The container's engine and stores behind a monitor with its own target resolver. */
function monitorWith(
  env: FakeEnv,
  resolveTarget: (op: OperationRecord) => Promise<OperationTarget | undefined>,
): Monitor {
  const internals = containerOf(env.aio);
  return new Monitor({
    engine: internals.engine(),
    stores: env.stores,
    events: internals.runtime.events,
    clock: internals.runtime.clock,
    log: noopLogger,
    namespace: 'default',
    lifecycle: () => withLifecycleDefaults(internals.effective().lifecycle),
    resolveTarget,
  });
}

/** A transport whose verified height is far above what the endpoint serves: a stale view. */
function withHighest(transport: Transport, highest: bigint): Transport {
  return new Proxy(transport, {
    get(real, prop) {
      if (prop === 'highestHeight') return () => highest;
      const value: unknown = Reflect.get(real, prop);
      return typeof value === 'function' ? (value as () => unknown).bind(real) : value;
    },
  });
}

/** A signed transfer whose only Attempt is proven rejected: the failed write was lost. */
async function rejectedButLive() {
  const faulty = new FaultyOperationStore(new MemoryOperationStore());
  const first = await createFakeEnv({ stores: { operations: faulty } });
  first.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
  faulty.crashOn({
    method: 'update',
    timing: 'before',
    when: (args) => (args[2] as OperationPatch | undefined)?.state === 'failed',
  });
  await expect(
    first.run(
      first.bc.transfer({ to: first.stranger(), amount: 3n }, { idempotencyKey: 'rj' }),
    ),
  ).rejects.toMatchObject({ ambiguous: true });
  const env = await first.restart({ killPrevious: true });
  const op = await env.stores.operations.getByKey('default', 'rj');
  if (!op) throw new Error('unreachable');
  expect(op.state).toBe('signed');
  return { env, op };
}

/** Fails the next write that returns a value to `released`, as a store outage would. */
class FailingReleaseStore implements SequenceStore {
  armed = false;
  readonly #inner = new MemorySequenceStore();

  get(key: string): Promise<SequenceState | null> {
    return this.#inner.get(key);
  }

  async put(
    key: string,
    state: Omit<SequenceState, 'version'>,
    expectedVersion: number | null,
  ): Promise<void> {
    const current = await this.#inner.get(key);
    if (this.armed && state.released.length > (current?.released.length ?? 0)) {
      this.armed = false;
      throw new Error('sequence store unavailable');
    }
    return this.#inner.put(key, state, expectedVersion);
  }
}

/** Lets another writer change the Operation right before the next `appendAttempt` lands. */
class RacingAppendStore extends MemoryOperationStore {
  race: OperationPatch | undefined;

  override async appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const race = this.race;
    this.race = undefined;
    const current = race ? await this.get(namespace, id) : null;
    if (race && current) await this.update(namespace, id, race, current.version);
    return super.appendAttempt(namespace, id, attempt, patch, expectedVersion, fence);
  }
}
