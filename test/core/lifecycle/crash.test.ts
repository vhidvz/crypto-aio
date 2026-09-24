import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { OperationPatch } from '../../../src/core/store/types';
import { createFakeEnv, type FakeEnvOptions } from '../../../src/testing/env';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner } from './support';

async function crashEnv(options: FakeEnvOptions = {}) {
  const { signer, calls } = countingSigner();
  const faulty = new FaultyOperationStore(new MemoryOperationStore());
  const env = await createFakeEnv({ ...options, signer, stores: { operations: faulty } });
  return { env, faulty, calls, intent: { to: env.stranger(), amount: 3n } };
}

const patchState = (state: string) => (args: readonly unknown[]) =>
  (args[2] as OperationPatch | undefined)?.state === state;

/** R26.2: a crash while recording a broadcast answer reaches the caller as ambiguous. */
const crashedAfterBroadcast = {
  ambiguous: true,
  retryable: true,
  context: expect.objectContaining({ operationId: expect.any(String) }),
  cause: expect.objectContaining({ name: 'CrashError' }),
};

describe('crash safety', () => {
  it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const stored = await env.stores.operations.getByKey('default', 'k');
    expect(stored?.state).toBe('signed');
    const ref = stored?.attempts[0]?.ref.id ?? '';
    expect(env.chain.sendCount(ref)).toBe(0);
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub.state).toBe('submitted');
    expect(sub.attempt?.id).toBe(ref);
    expect(calls()).toBe(1);
  });

  it('recovers when the process died after broadcasting but before recording it', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'update', timing: 'before', when: patchState('submitted') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject(crashedAfterBroadcast);
    const stored = await env.stores.operations.getByKey('default', 'k');
    const ref = stored?.attempts[0]?.ref.id ?? '';
    expect(stored?.state).toBe('signed');
    expect(env.chain.inMempool(ref)).toBe(true);
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub.state).toBe('submitted');
    expect(env.chain.sendCount(ref)).toBe(2);
    expect(calls()).toBe(1);
  });

  it('treats "nonce too low" for its own already-mined transaction as success', async () => {
    const { env, faulty, intent } = await crashEnv();
    faulty.crashOn({ method: 'update', timing: 'before', when: patchState('submitted') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject(crashedAfterBroadcast);
    env.chain.mine();
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub.state).toBe('submitted');
  });

  it('resumes a prepared transfer and keeps its nonce reserved for it', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'update', timing: 'after', when: patchState('prepared') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    expect((await env.stores.operations.getByKey('default', 'k'))?.reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
    const restarted = await env.restart({ killPrevious: true });
    const other = await restarted.run(
      restarted.bc.transfer(
        { to: env.stranger(), amount: 1n },
        { idempotencyKey: 'other' },
      ),
    );
    expect(
      (await restarted.stores.operations.get('default', other.operationId))?.reservation,
    ).toEqual({ kind: 'nonce', nonce: 1n });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub.state).toBe('submitted');
    expect(calls()).toBe(2);
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(2n);
  });

  it('resumes an operation whose creation was the last thing recorded', async () => {
    const { env, faulty, intent } = await crashEnv();
    faulty.crashOn({ method: 'create', timing: 'after' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    expect((await env.stores.operations.getByKey('default', 'k'))?.state).toBe('created');
    const restarted = await env.restart({ killPrevious: true });
    expect(
      (await restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' }))).state,
    ).toBe('submitted');
  });

  // Write-ahead: nothing reaches the network before the signed Attempt is persisted.
  it('never broadcasts signed bytes whose attempt was not persisted', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    let sends = 0;
    env.aio.on('rpc.request', (e) => {
      if (e.method === 'fake_sendRawTransaction') sends += 1;
    });
    faulty.crashOn({ method: 'appendAttempt', timing: 'before' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const stored = await env.stores.operations.getByKey('default', 'k');
    expect(stored).toMatchObject({ state: 'prepared', attempts: [] });
    expect(sends).toBe(0);
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub.state).toBe('submitted');
    expect(calls()).toBe(2);
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(1n);
    expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
  });

  // Recovery (Task 26) resumes through `rebroadcast`, which resends the stored raw bytes.
  it('rebroadcasts the persisted attempt after a restart without signing again', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const stored = await env.stores.operations.getByKey('default', 'k');
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(restarted.bc.rebroadcast(stored?.id ?? ''));
    expect(sub).toMatchObject({ state: 'submitted', ambiguous: false });
    expect(sub.attempt?.id).toBe(stored?.attempts[0]?.ref.id);
    expect(calls()).toBe(1);
    env.chain.mine();
    expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
  });

  it('keeps an ambiguous broadcast across a restart and resolves it without signing again', async () => {
    const { env, calls, intent } = await crashEnv({ transport: { maxAttempts: 1 } });
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ ambiguous: true });
    const stored = await env.stores.operations.getByKey('default', 'k');
    expect(stored).toMatchObject({ state: 'submitted', ambiguous: true });
    const ref = stored?.attempts[0]?.ref.id ?? '';
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub).toMatchObject({ state: 'submitted', ambiguous: false });
    expect(sub.attempt?.id).toBe(ref);
    expect(env.chain.sendCount(ref)).toBe(2);
    expect(calls()).toBe(1);
  });

  it.each(['before', 'after'] as const)(
    'resumes without signing again when the process died %s the broadcast observation write',
    async (timing) => {
      const { env, faulty, calls, intent } = await crashEnv();
      faulty.crashOn({ method: 'putObservation', timing });
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject(crashedAfterBroadcast);
      const stored = await env.stores.operations.getByKey('default', 'k');
      expect(stored?.state).toBe('signed');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      const restarted = await env.restart({ killPrevious: true });
      const sub = await restarted.run(
        restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
      );
      expect(sub).toMatchObject({ state: 'submitted', ambiguous: false });
      expect(sub.attempt?.id).toBe(ref);
      expect(calls()).toBe(1);
      env.chain.mine();
      expect(env.chain.receipt(ref)?.success).toBe(true);
    },
  );

  it.each(['before', 'after'] as const)(
    'keeps the nonce and never re-signs when the process died %s the stalled write',
    async (timing) => {
      const { env, faulty, calls, intent } = await crashEnv();
      env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
      faulty.crashOn({ method: 'update', timing, when: patchState('stalled') });
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject(crashedAfterBroadcast);
      const stored = await env.stores.operations.getByKey('default', 'k');
      expect(stored?.state).toBe(timing === 'before' ? 'signed' : 'stalled');
      expect(stored?.reservation).toEqual({ kind: 'nonce', nonce: 0n });
      const ref = stored?.attempts[0]?.ref.id ?? '';
      const restarted = await env.restart({ killPrevious: true });
      if (timing === 'after') {
        await expect(
          restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' })),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      }
      const sub =
        timing === 'before'
          ? await restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' }))
          : await restarted.run(restarted.bc.rebroadcast(stored?.id ?? ''));
      expect(sub.state).toBe('submitted');
      expect(sub.attempt?.id).toBe(ref);
      expect(calls()).toBe(1);
      env.chain.mine();
      expect(env.chain.receipt(ref)?.success).toBe(true);
    },
  );

  it('keeps the nonce reserved when the process died before the failed write', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    faulty.crashOn({ method: 'update', timing: 'before', when: patchState('failed') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject(crashedAfterBroadcast);
    const stored = await env.stores.operations.getByKey('default', 'k');
    expect(stored).toMatchObject({
      state: 'signed',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    const restarted = await env.restart({ killPrevious: true });
    // The node rejects the same bytes again: now the Operation fails and frees its nonce.
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    await expect(
      restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ code: 'TX_REJECTED' });
    expect(calls()).toBe(1);
    const first = await restarted.run(
      restarted.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const second = await restarted.run(
      restarted.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    const nonces = await Promise.all(
      [first, second].map(
        async (p) =>
          (await restarted.stores.operations.get('default', p.operation.id))?.reservation,
      ),
    );
    expect(nonces).toEqual([
      { kind: 'nonce', nonce: 0n },
      { kind: 'nonce', nonce: 1n },
    ]);
  });

  // Task 26 (carry-forward) reconciles this gap; here the nonce is never handed out twice.
  it('never hands out a nonce twice when the process died after the failed write', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    faulty.crashOn({ method: 'update', timing: 'after', when: patchState('failed') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject(crashedAfterBroadcast);
    expect((await env.stores.operations.getByKey('default', 'k'))?.state).toBe('failed');
    const restarted = await env.restart({ killPrevious: true });
    await expect(
      restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ code: 'TX_REJECTED' });
    expect(calls()).toBe(1);
    const next = await restarted.run(
      restarted.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(
      (await restarted.stores.operations.get('default', next.operation.id))?.reservation,
    ).toEqual({ kind: 'nonce', nonce: 1n });
  });
});
