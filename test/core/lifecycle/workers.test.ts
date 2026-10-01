import { secp256k1 } from '@noble/curves/secp256k1';
import { internalsOf } from '../../../src/core/blockchain/internal';
import type { WalletConfig } from '../../../src/core/config/types';
import { CryptoAio } from '../../../src/core/container/container';
import { containerOf } from '../../../src/core/container/internals';
import { ChainError } from '../../../src/core/errors/error';
import { noopLogger, type Logger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import {
  withLifecycleDefaults,
  type OperationTarget,
} from '../../../src/core/lifecycle/engine';
import { Monitor } from '../../../src/core/lifecycle/monitor';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { secret } from '../../../src/core/secret/secret';
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
  OperationFilter,
  OperationPatch,
  OperationRecord,
  SequenceState,
  SequenceStore,
} from '../../../src/core/store/types';
import type { Transport } from '../../../src/core/transport/types';
import {
  createFakeEnv,
  type FakeEnv,
  type FakeEnvOptions,
} from '../../../src/testing/env';
import { REVERT_ADDRESS, signFake } from '../../../src/testing/fake-chain';
import { fakePlugin } from '../../../src/testing/fake-plugin';
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

describe('workers schedule every pass they make', () => {
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

  // A quiet wallet (no worker pass, no recovery) is never stuck behind a leaked nonce.
  it('reclaims a leaked nonce in the next prepare of a quiet wallet', async () => {
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
    const sub = await restarted.run(
      restarted.bc.transfer(
        { to: restarted.stranger(), amount: 1n },
        { idempotencyKey: 'next' },
      ),
    );
    expect((await stored(restarted, sub.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    restarted.chain.mine();
    expect(restarted.chain.nonce(restarted.address)).toBe(1n);
    // The leaked Operation itself still prepares afterwards, on the next value.
    const leaked = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'leak' }),
    );
    expect((await stored(restarted, leaked.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
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
    // The blocked transfer is allocated before the leak (a later prepare reclaims it).
    veto = false;
    const vetoed = { to: env.stranger(), amount: 1n };
    await env.run(env.bc.prepareTransfer(vetoed, { idempotencyKey: 'vetoed' }));
    const blocked = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, blocked.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
    veto = true;
    sequences.armed = true;
    await expect(
      env.run(env.bc.prepareTransfer(vetoed, { idempotencyKey: 'vetoed' })),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    expect(await sequenceOf(env)).toMatchObject({ next: 2n, released: [] });
    veto = false;
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
    // The blocked transfer is allocated before the leak (a later prepare reclaims it).
    const blocked = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect((await stored(env, blocked.operationId)).reservation).toEqual({
      kind: 'nonce',
      nonce: 2n,
    });
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

describe('a lost append keeps its contract', () => {
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

describe('gaps follow the pending nonce; verdicts carry the claim', () => {
  it('reports no gap while every lower nonce is still pending (congestion)', async () => {
    const env = await createFakeEnv();
    const gaps: AioEvent[] = [];
    env.aio.on('nonce.gap', (e) => gaps.push(e));
    const reconcile = jest.spyOn(containerOf(env.aio).engine(), 'reconcileNonces');
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.clock.advance(11_000);
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(2);
    expect(gaps).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("never lands a stale worker's all-rejected verdict after a takeover", async () => {
    const { env, op } = await rejectedButLive();
    const store = env.stores.operations;
    const [stale] = await store.claimDue('default', 'a', env.clock.now(), 1_000, 10);
    await env.clock.advance(1_500);
    const [current] = await store.claimDue('default', 'b', env.clock.now(), 1_000, 10);
    if (!stale?.claim || !current?.claim) throw new Error('unreachable');
    const monitor = containerOf(env.aio).monitor();
    const target = await targetOf(env);
    await env.run(monitor.check(target, current, { claimToken: stale.claim.token }));
    expect((await stored(env, op.id)).state).toBe('signed');
    const decided = await env.run(
      monitor.check(target, await stored(env, op.id), {
        claimToken: current.claim.token,
      }),
    );
    expect(decided.state).toBe('failed');
  });
});

describe('workers: lagging endpoints, stale views, aborts and batch sizes', () => {
  it('never releases a consumed nonce when a lagging endpoint under-reports pending', async () => {
    const env = await createFakeEnv();
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await mineWhile(env, first.wait({ finality: 'final' }));
    await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    env.chain.configureEndpoint('main', { lag: 60 });
    const report = await env.run(env.aio.operations.recover());
    expect(report).toMatchObject({ failed: 0, reconciled: 0 });
    expect(await sequenceOf(env)).toMatchObject({ next: 2n, released: [] });
  });

  it('skips gap handling and reconciliation on a stale-view pass', async () => {
    const env = await createFakeEnv();
    const gaps: AioEvent[] = [];
    env.aio.on('nonce.gap', (e) => gaps.push(e));
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 3n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.clock.advance(11_000);
    const reconcile = jest.spyOn(containerOf(env.aio).engine(), 'reconcileNonces');
    const real = await targetOf(env);
    const stale: OperationTarget = {
      ...real,
      pooled: { ...real.pooled, transport: withHighest(real.pooled.transport, 1_000n) },
    };
    expect(
      await env.run(monitorWith(env, async () => stale).runOnce({ workerId: 'w' })),
    ).toBe(2);
    expect(gaps).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('stops a worker waiting on a busy lease as soon as its signal aborts', async () => {
    const { env, op } = await rejectedButLive();
    await env.stores.locks.acquire(leaseKey(env), 'elsewhere', 600_000);
    const ctl = new AbortController();
    const worker = env.aio.monitor.start({ workerId: 'w', signal: ctl.signal });
    await env.clock.advance(1_000); // the fenced pass waits for the address lease
    ctl.abort();
    const aborted = env.clock.now();
    await env.run(worker);
    expect(env.clock.now() - aborted).toBeLessThan(1_000);
    expect((await stored(env, op.id)).state).toBe('signed');
  });

  it('claims at most `batch` operations per pass, and passes again after a full one', async () => {
    const operations = new ClaimRecordingStore();
    const env = await createFakeEnv({ stores: { operations } });
    for (let i = 0; i < 3; i++)
      await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w', batch: 2 }))).toBe(2);
    await env.clock.advance(1_000);
    operations.claims.length = 0;
    const ctl = new AbortController();
    const worker = env.aio.monitor.start({ workerId: 'w', batch: 2, signal: ctl.signal });
    await env.clock.advance(0);
    expect(operations.claims.slice(0, 3)).toEqual([
      { limit: 2, claimed: 2 },
      { limit: 2, claimed: 1 },
    ]);
    ctl.abort();
    await env.run(worker);
  });
});

describe('workers: the consumed-nonce floor, wallet history reads and shutdown', () => {
  it('never releases the nonce of a mined revert when a lagging endpoint under-reports pending', async () => {
    const env = await createFakeEnv();
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await mineWhile(env, first.wait({ finality: 'final' }));
    const reverted = await env.run(env.bc.transfer({ to: REVERT_ADDRESS, amount: 1n }));
    await expect(
      mineWhile(env, reverted.wait({ finality: 'final' })),
    ).rejects.toMatchObject({ code: 'TX_REVERTED' });
    expect((await stored(env, reverted.operationId)).state).toBe('failed');
    await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    env.chain.configureEndpoint('main', { lag: 200 });
    const report = await env.run(env.aio.operations.recover());
    expect(report).toMatchObject({ failed: 0, reconciled: 0 });
    expect(await sequenceOf(env)).toMatchObject({ next: 3n, released: [] });
  });

  // The floor counts a proven replacement's nonce as consumed. Known gap: reconciliation
  // still starts from the chain's pending nonce, so while an endpoint lags it can reclaim
  // a value that only a transaction outside this namespace's records consumed; a
  // transfer that reuses it fails, and nothing is paid twice.
  it('never releases the nonce of a proven replacement when a lagging endpoint under-reports pending', async () => {
    const key = secp256k1.utils.randomPrivateKey();
    const env = await createFakeEnv({
      signer: localSigner({ id: 'hot', secp256k1: secret(key) }),
    });
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await mineWhile(env, first.wait({ finality: 'final' }));
    const replaced = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.submit(
      signFake(
        {
          chainId: 'fake-local',
          from: env.address,
          to: env.stranger(),
          amount: '1',
          fee: '9',
          nonce: '1',
        },
        key,
      ),
    );
    await expect(
      mineWhile(env, replaced.wait({ finality: 'final' })),
    ).rejects.toMatchObject({ code: 'TX_REPLACED' });
    expect(await stored(env, replaced.operationId)).toMatchObject({
      state: 'failed',
      error: { code: 'TX_REPLACED' },
    });
    await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }));
    env.chain.configureEndpoint('main', { lag: 200 });
    const report = await env.run(env.aio.operations.recover());
    expect(report).toMatchObject({ failed: 0, reconciled: 0 });
    expect(await sequenceOf(env)).toMatchObject({ next: 3n, released: [] });
  });

  it('lists no wallet history when there is nothing to reclaim', async () => {
    const operations = new ListRecordingStore();
    const env = await createFakeEnv({ stores: { operations } });
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    operations.filters.length = 0;
    expect(await env.run(env.aio.operations.recover())).toMatchObject({ reconciled: 0 });
    const history = operations.filters.filter((filter) =>
      filter.states?.some((state) => state === 'final' || state === 'failed'),
    );
    expect(history).toEqual([]);
  });

  it('claims nothing once its signal has aborted', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const ctl = new AbortController();
    ctl.abort();
    expect(
      await env.run(env.aio.monitor.runOnce({ workerId: 'w', signal: ctl.signal })),
    ).toBe(0);
    expect((await stored(env, sub.operationId)).claim).toBeUndefined();
  });

  it('logs a check stopped by shutdown at debug level, not as a failure', async () => {
    const { log, warnings, debugs } = capturingLogger();
    const { env } = await rejectedButLive({ aio: { logger: log } });
    await env.stores.locks.acquire(leaseKey(env), 'elsewhere', 600_000);
    const ctl = new AbortController();
    const worker = env.aio.monitor.start({ workerId: 'w', signal: ctl.signal });
    await env.clock.advance(1_000); // the fenced pass waits for the address lease
    ctl.abort();
    await env.run(worker);
    expect(warnings.map((w) => w.message)).not.toContain('monitor check failed');
    expect(debugs.map((d) => d.message)).toContain('monitor check stopped');
  });
});

describe('reconciliation fences out a stale prepared write', () => {
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

describe('monitoring is signer-free', () => {
  it('takes an in-flight operation to final after its signer id is rotated out of config', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    // Another process whose config no longer has signer 'hot': the wallet is watch-only.
    const rotated = rotatedContainer(env, { main: { address: env.address } });
    for (let i = 0; i < 20; i++) {
      env.chain.mine();
      await env.clock.advance(1_000);
      await env.run(rotated.monitor.runOnce({ workerId: 'r' }));
    }
    expect((await stored(env, sub.operationId)).state).toBe('final');
  });

  it('recover() still rebroadcasts a signed operation after its signer id is rotated out', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({ stores: { operations: faulty } });
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'signed' }),
      ),
    ).rejects.toBeInstanceOf(CrashError);
    const rotated = rotatedContainer(env, { main: { address: env.address } });
    const report = await env.run(rotated.operations.recover());
    expect(report).toMatchObject({ rebroadcast: 1, checked: 1, failed: 0 });
    const signed = await env.stores.operations.getByKey('default', 'signed');
    expect(signed?.state).toBe('submitted');
    expect(env.chain.inMempool(signed?.attempts[0]?.ref.id ?? '')).toBe(true);
  });

  it('never lets a hung getPublicKey stall the checks of a worker pass', async () => {
    const { signer, hang } = keyReadingSigner();
    const env = await createFakeEnv({ signer });
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const second = await env.run(env.bc.transfer({ to: env.stranger(), amount: 2n }));
    hang();
    env.chain.mine();
    const started = env.clock.now();
    // Both Operations share one execution context (configHash).
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(2);
    expect(env.clock.now() - started).toBeLessThan(1_000);
    expect((await stored(env, first.operationId)).state).toBe('included');
    expect((await stored(env, second.operationId)).state).toBe('included');
  });

  it('bounds the wallet a write needs by signTimeoutMs, then leaves the verdict for later', async () => {
    const { signer, hang } = keyReadingSigner();
    const { log, warnings } = capturingLogger();
    const { env, op } = await rejectedButLive({
      signer,
      lifecycle: { signTimeoutMs: 5_000 },
      aio: { logger: log },
    });
    hang();
    const started = env.clock.now();
    expect(await env.run(env.aio.monitor.runOnce({ workerId: 'w' }))).toBe(1);
    expect(env.clock.now() - started).toBeLessThan(6_000);
    const after = await stored(env, op.id);
    expect(after.state).toBe('signed');
    expect(after.nextCheckAt).toBeGreaterThan(env.clock.now());
    expect(warnings).toContainEqual({
      message: expect.any(String),
      fields: { operationId: op.id, code: 'TIMEOUT' },
    });
  });

  it('resolves the wallet a write needs once per container, and again after a config change', async () => {
    const { signer, reads } = keyReadingSigner();
    const env = await createFakeEnv({ signer });
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 3n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await env.clock.advance(11_000);
    const reconcile = jest.spyOn(containerOf(env.aio).engine(), 'reconcileNonces');
    const before = reads();
    for (let i = 0; i < 3; i++) {
      await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
      await env.clock.advance(1_000);
    }
    // Every pass reconciled the gap (a write), yet the key was read once.
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(reads()).toBe(before + 1);
    env.aio.use({ name: 'config-change' });
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(reads()).toBe(before + 2);
  });

  it('does not read the wallet public key on every worker pass', async () => {
    const { signer, reads } = keyReadingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const before = reads();
    for (let i = 0; i < 5; i++) {
      env.chain.mine();
      await env.clock.advance(1_000);
      await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    }
    expect((await stored(env, sub.operationId)).state).not.toBe('submitted');
    expect(reads()).toBe(before);
  });
});

describe('resends carry the pass signal', () => {
  it('passes the pass signal to the rebroadcast of a dropped attempt', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const op = await stored(env, sub.operationId);
    env.chain.dropFromMempool(op.attempts[0]?.ref.id ?? '');
    await env.clock.advance(11_000);
    const signals = await broadcastSignals(env);
    const ctl = new AbortController();
    expect(
      await env.run(env.aio.monitor.runOnce({ workerId: 'w', signal: ctl.signal })),
    ).toBe(1);
    expect(signals).toHaveLength(1);
    // The pass runs under the caller's signal combined with the container's `closing`,
    // so the root's `close()` stops it too.
    expect(signals[0]?.aborted).toBe(false);
    ctl.abort();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("passes recovery's signal to the resend of a signed operation", async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({ stores: { operations: faulty } });
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 3n })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    const signals = await broadcastSignals(restarted);
    const ctl = new AbortController();
    expect(
      await restarted.run(restarted.aio.operations.recover({ signal: ctl.signal })),
    ).toMatchObject({ rebroadcast: 1, failed: 0 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    ctl.abort();
    expect(signals[0]?.aborted).toBe(true);
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

/** A logger that records every warning's and debug record's message and fields. */
function capturingLogger() {
  const warnings: { message: string; fields: unknown }[] = [];
  const debugs: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    ...noopLogger,
    warn: (message, fields) => warnings.push({ message, fields }),
    debug: (message, fields) => debugs.push({ message, fields }),
    child: () => log,
  };
  return { log, warnings, debugs };
}

/** Records the filter of every `list` call. */
class ListRecordingStore extends MemoryOperationStore {
  readonly filters: OperationFilter[] = [];

  override async list(filter: OperationFilter): Promise<OperationRecord[]> {
    this.filters.push(filter);
    return super.list(filter);
  }
}

/** Records every `claimDue` limit and how many Operations it claimed. */
class ClaimRecordingStore extends MemoryOperationStore {
  readonly claims: { limit: number; claimed: number }[] = [];

  override async claimDue(
    namespace: string,
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<OperationRecord[]> {
    const claimed = await super.claimDue(namespace, workerId, now, leaseMs, limit);
    this.claims.push({ limit, claimed: claimed.length });
    return claimed;
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

/** The container's engine and stores behind a monitor with its own target resolver (reads and writes). */
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
    resolveRead: resolveTarget,
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
async function rejectedButLive(options: FakeEnvOptions = {}) {
  const faulty = new FaultyOperationStore(new MemoryOperationStore());
  const first = await createFakeEnv({ ...options, stores: { operations: faulty } });
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

/** A local signer whose public-key reads are counted and can be made to hang forever. */
function keyReadingSigner(): { signer: Signer; reads: () => number; hang: () => void } {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  let reads = 0;
  let hung = false;
  const signer = callbackSigner({
    id: 'hot',
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => {
      reads += 1;
      return hung
        ? new Promise<Uint8Array>(() => undefined)
        : inner.getPublicKey(scheme, keyRef);
    },
    sign: (requests, ctx) => inner.sign(requests, ctx),
  });
  const hang = () => {
    hung = true;
  };
  return { signer, reads: () => reads, hang };
}

/**
 * Another process on `env`'s chain, clock and stores whose config has other wallets and
 * signers (by default none): e.g. signer 'hot' rotated out.
 */
function rotatedContainer(
  env: FakeEnv,
  wallets: Readonly<Record<string, WalletConfig>>,
  signers: Readonly<Record<string, Signer>> = {},
): CryptoAio {
  return new CryptoAio({
    env: false,
    logger: noopLogger,
    plugins: [fakePlugin()],
    clock: env.clock,
    stores: env.stores,
    providers: {
      fake: { endpoints: [{ name: 'main', url: env.chain.endpoint('main') }] },
    },
    signers,
    wallets,
    chains: { [env.chainId]: { provider: 'fake', wallet: 'main' } },
    lifecycle: { pollIntervalMs: 1_000, droppedGracePeriodMs: 10_000 },
    transport: {
      fetch: env.chain.fetch,
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 5_000,
    },
  });
}

/** Records the `signal` of every broadcast through `env`'s pooled driver. */
async function broadcastSignals(env: FakeEnv): Promise<(AbortSignal | undefined)[]> {
  const { driver } = await internalsOf(env.bc).pooled();
  const broadcast = driver.broadcaster.broadcast.bind(driver.broadcaster);
  const signals: (AbortSignal | undefined)[] = [];
  driver.broadcaster.broadcast = (signed, options) => {
    signals.push(options?.signal);
    return broadcast(signed, options);
  };
  return signals;
}
