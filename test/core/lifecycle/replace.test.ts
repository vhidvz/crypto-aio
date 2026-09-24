import { internalsOf } from '../../../src/core/blockchain/internal';
import { containerOf } from '../../../src/core/container/internals';
import type { OperationTarget } from '../../../src/core/lifecycle/engine';
import type { FeeSpeed } from '../../../src/core/model/fee';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { SigningResult } from '../../../src/core/signing/types';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type {
  AttemptRecord,
  Fence,
  OperationPatch,
  OperationRecord,
} from '../../../src/core/store/types';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';
import type { FakeClock } from '../../../src/testing/fake-clock';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner, mineWhile } from './support';

/**
 * Signs `original` Attempts locally; every other purpose (replacement, cancel, rebuild) is
 * answered by `other`, which may call `own()` to sign locally after all.
 */
function purposeSigner(
  other: (own: () => Promise<SigningResult>) => Promise<SigningResult>,
  cancelled: string[] = [],
) {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  let calls = 0;
  const signer = callbackSigner({
    id: 'hot',
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      calls += 1;
      const own = () => inner.sign(requests, ctx);
      return ctx.purpose === 'original' ? own() : other(own);
    },
    cancelRequest: async (ticket) => {
      cancelled.push(ticket);
    },
  });
  return { signer, calls: () => calls };
}

/** Bumps the Operation's version (as a worker's claim does) right before the next append. */
class RacingStore extends MemoryOperationStore {
  race?: OperationPatch;

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

async function stored(env: FakeEnv, operationId: string): Promise<OperationRecord> {
  const op = await env.stores.operations.get('default', operationId);
  if (!op) throw new Error(`operation ${operationId} not stored`);
  return op;
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

/** Transfers on an expiry chain, drops the Attempt and waits until its expiry is proven. */
async function expiredTransfer(env: FakeEnv, recipient: string) {
  const sub = await env.run(env.bc.transfer({ to: recipient, amount: 7n }));
  env.chain.dropFromMempool(sub.attempt?.id ?? '');
  await expect(
    mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
  ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
  return sub;
}

const expiryEnv = (options: Parameters<typeof createFakeEnv>[0] = {}) =>
  createFakeEnv({
    ordering: 'expiry',
    lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    ...options,
  });

describe('replace, cancel and rebuild', () => {
  it('replaces a transaction with a higher fee and settles on the replacement', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: 7n, fee: 'slow' }),
    );
    const original = sub.attempt?.id ?? '';
    const replaced = await env.run(env.bc.replace(sub.operationId, { fee: 'fast' }));
    expect(replaced.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(replaced.attempt?.id).not.toBe(original);
    expect(env.chain.inMempool(original)).toBe(false);
    const final = await mineWhile(env, replaced.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(
      await env.stores.operations.getObservation(sub.attempts[0]?.id ?? ''),
    ).toMatchObject({
      state: 'replaced',
      evidence: 'proven',
      replacedBy: replaced.attempt?.id,
    });
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  it('refuses an underpriced replacement before signing and leaves the operation unchanged', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'normal' })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('submitted');
    expect(op?.attempts).toHaveLength(1);
  });

  it('cancels with a conflicting self-transfer and reports the cancelled outcome', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: 7n, fee: 'slow' }),
    );
    const cancelled = await env.run(env.bc.cancel(sub.operationId));
    expect(cancelled.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
    const final = await mineWhile(env, cancelled.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect(env.chain.balance(recipient)).toBe(0n);
  });

  it('reports a cancel that lost the race and keeps the original outcome', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    env.chain.mine();
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'NONCE_CONFLICT',
    });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('submitted');
    expect(op?.activeAttemptId).toBe(op?.attempts[0]?.id);
    const final = await mineWhile(
      env,
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation?.outcome).toBe('executed');
  });

  it('does not offer replace or cancel on expiry chains', async () => {
    const env = await createFakeEnv({ ordering: 'expiry' });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('rebuilds an expired transfer only after its expiry is proven', async () => {
    const env = await createFakeEnv({
      ordering: 'expiry',
      lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    });
    const recipient = env.stranger();
    const sub = await env.run(env.bc.transfer({ to: recipient, amount: 7n }));
    env.chain.dropFromMempool(sub.attempt?.id ?? '');
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(
      mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    expect(rebuilt.attempts.map((a) => a.purpose)).toEqual(['original', 'rebuild']);
    expect(rebuilt.state).toBe('submitted');
    const final = await mineWhile(env, rebuilt.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  // ---- replace and cancel: refusals and the node's answer -------------------------------

  it('validates the replacement fee before anything else', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    for (const fee of [
      { fee: 5 },
      'turbo' as FeeSpeed,
      undefined as unknown as FeeSpeed,
    ]) {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee })),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    expect((await stored(env, sub.operationId)).attempts).toHaveLength(1);
  });

  it('replaces a stalled transfer that the node refused as underpriced', async () => {
    const env = await createFakeEnv({ chain: { minFee: 10n } });
    const recipient = env.stranger();
    await expect(
      env.run(
        env.bc.transfer(
          { to: recipient, amount: 7n, fee: { fee: 1n } },
          { idempotencyKey: 'cheap' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const stalled = await env.stores.operations.getByKey('default', 'cheap');
    expect(stalled?.state).toBe('stalled');
    const replaced = await env.run(env.bc.replace(stalled?.id ?? '', { fee: 'normal' }));
    expect(replaced).toMatchObject({ state: 'submitted', ambiguous: false });
    expect(replaced.error).toBeUndefined();
    const final = await mineWhile(env, replaced.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  it('restores the previous state and active attempt when the node refuses a replacement', async () => {
    const { signer, calls } = countingSigner();
    // The driver asks for a 10% bump; this node wants 50%.
    const env = await createFakeEnv({
      signer,
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const original = sub.attempt?.id ?? '';
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    expect(calls()).toBe(2);
    const op = await stored(env, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.error).toBeUndefined();
    expect(
      await env.stores.operations.getObservation(op.attempts[1]?.id ?? ''),
    ).toMatchObject({ state: 'refused', evidence: 'observed' });
    // The original is still live and keeps its nonce.
    expect(env.chain.inMempool(original)).toBe(true);
    const final = await mineWhile(env, sub.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('refuses, before signing, a new attempt that would not conflict with the earlier ones', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const { driver } = await internalsOf(env.bc).pooled();
    const policy = driver.replacement as {
      buildReplacement?: NonNullable<typeof driver.replacement>['buildReplacement'];
    };
    const build = policy.buildReplacement;
    if (!build) throw new Error('the fake driver replaces fees');
    policy.buildReplacement = async (previous, fee, ctx) => ({
      ...(await build.call(policy, previous, fee, ctx)),
      ordering: { kind: 'nonce', nonce: 1n },
    });
    try {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    } finally {
      policy.buildReplacement = build;
    }
    expect(calls()).toBe(1);
    const op = await stored(env, sub.operationId);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.attempts).toHaveLength(1);
  });

  // ---- replace and cancel: signing ------------------------------------------------------

  it('refuses a replacement from an asynchronous signer and cancels its ticket', async () => {
    const cancelled: string[] = [];
    const { signer } = purposeSigner(
      async () => ({ status: 'pending', ticket: 'job-r' }),
      cancelled,
    );
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    expect(cancelled).toEqual(['job-r']);
    const op = await stored(env, sub.operationId);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.attempts).toHaveLength(1);
    expect(op.signerTickets).toBeUndefined();
  });

  it('stops waiting for a replacement signer after lifecycle.signTimeoutMs and writes nothing', async () => {
    const { signer } = purposeSigner(() => new Promise<SigningResult>(() => undefined));
    const env = await createFakeEnv({ signer, lifecycle: { signTimeoutMs: 60_000 } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const started = env.clock.now();
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' }), 1_000),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    const waited = env.clock.now() - started;
    expect(waited).toBeGreaterThanOrEqual(60_000);
    expect(waited).toBeLessThanOrEqual(61_000);
    const op = await stored(env, sub.operationId);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.attempts).toHaveLength(1);
    expect(env.clock.pending).toBe(0);
    // The lease was given back: the next transfer allocates the next nonce straight away.
    const other = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect((await stored(env, other.operation.id)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
  });

  it('keeps the address lease alive for a replacement signer slower than leaseMs', async () => {
    const clock: { current?: FakeClock } = {};
    const { signer } = purposeSigner(async (own) => {
      await clock.current?.sleep(45_000);
      return own();
    });
    const env = await createFakeEnv({
      signer,
      lifecycle: { leaseMs: 30_000, signTimeoutMs: 120_000 },
    });
    clock.current = env.clock;
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const replaced = await env.run(
      env.bc.replace(sub.operationId, { fee: 'fast' }),
      1_000,
    );
    expect(replaced.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(env.chain.inMempool(replaced.attempt?.id ?? '')).toBe(true);
  });

  // ---- replace and cancel: persistence ----------------------------------------------------

  it('retries a lost compare-and-set under the same lease without signing again', async () => {
    const store = new RacingStore();
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer, stores: { operations: store } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    store.race = { nextCheckAt: env.clock.now() };
    const replaced = await env.run(env.bc.replace(sub.operationId, { fee: 'fast' }));
    expect(replaced.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(env.chain.inMempool(replaced.attempt?.id ?? '')).toBe(true);
    expect(calls()).toBe(2);
  });

  it('reports a lost compare-and-set when the operation moved on, and appends nothing', async () => {
    const store = new RacingStore();
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer, stores: { operations: store } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    store.race = { state: 'included' };
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(calls()).toBe(2);
    const op = await stored(env, sub.operationId);
    expect(op.state).toBe('included');
    expect(op.attempts).toHaveLength(1);
    // The unpersisted replacement was never sent.
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(true);
  });

  it('resends a persisted replacement after a crash instead of signing a second one', async () => {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({ signer, stores: { operations: faulty } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toBeInstanceOf(CrashError);
    const crashed = await stored(env, sub.operationId);
    expect(crashed.state).toBe('signed');
    const replacement = crashed.attempts[1]?.ref.id ?? '';
    expect(env.chain.sendCount(replacement)).toBe(0);
    const restarted = await env.restart({ killPrevious: true });
    const again = await restarted.run(
      restarted.bc.replace(sub.operationId, { fee: 'fast' }),
    );
    expect(again.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(again).toMatchObject({ state: 'submitted', attempt: { id: replacement } });
    expect(env.chain.inMempool(replacement)).toBe(true);
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(false);
    expect(calls()).toBe(2);
  });

  it('returns the in-flight cancel on a repeat and never replaces a cancel', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const first = await env.run(env.bc.cancel(sub.operationId));
    const again = await env.run(env.bc.cancel(sub.operationId));
    expect(again.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
    expect(again.attempt?.id).toBe(first.attempt?.id);
    // A replacement would be built from the cancel's self-transfer, yet report `executed`.
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 100n } })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await stored(env, sub.operationId)).attempts).toHaveLength(2);
    expect(calls()).toBe(2);
  });

  // ---- rebuild ------------------------------------------------------------------------

  it('refuses to rebuild while an earlier attempt could still be included', async () => {
    const { signer, calls } = countingSigner();
    const env = await expiryEnv({ signer });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    // A store that claims `expired` without proof: the attempt is live in the mempool.
    const op = await stored(env, sub.operationId);
    await env.stores.operations.update(
      'default',
      op.id,
      { state: 'expired' },
      op.version,
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(await stored(env, sub.operationId)).toMatchObject({
      state: 'expired',
      attempts: [expect.objectContaining({ purpose: 'original' })],
    });
    expect(calls()).toBe(1);
  });

  it('refuses to rebuild an attempt that was included at finality', async () => {
    const env = await expiryEnv();
    const recipient = env.stranger();
    const sub = await env.run(env.bc.transfer({ to: recipient, amount: 7n }));
    await mineWhile(env, sub.wait({ finality: 'final' }));
    // Past its expiry per finalized state too: only the inclusion proof can refuse it now.
    env.chain.mine(10);
    const op = await stored(env, sub.operationId);
    await env.stores.operations.update(
      'default',
      op.id,
      { state: 'expired', clear: ['outcome'] },
      op.version,
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect((await stored(env, sub.operationId)).attempts).toHaveLength(1);
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  it('rebuilds once when two rebuilds race', async () => {
    const { signer, calls } = countingSigner();
    const env = await expiryEnv({ signer });
    const sub = await expiredTransfer(env, env.stranger());
    const results = await env.run(
      Promise.allSettled([
        env.bc.rebuild(sub.operationId),
        env.bc.rebuild(sub.operationId),
      ]),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    });
    expect((await stored(env, sub.operationId)).attempts).toHaveLength(2);
    expect(calls()).toBe(2);
  });

  it('keeps every terminal state final except an expired operation that is rebuilt', async () => {
    const nonce = await createFakeEnv();
    const live = await nonce.run(nonce.bc.transfer({ to: nonce.stranger(), amount: 7n }));
    await expect(nonce.run(nonce.bc.rebuild(live.operationId))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });

    const env = await expiryEnv();
    const done = await env.run(env.bc.transfer({ to: env.stranger(), amount: 7n }));
    await mineWhile(env, done.wait({ finality: 'final' }));
    await expect(env.run(env.bc.rebuild(done.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });

    const sub = await expiredTransfer(env, env.stranger());
    const expired = await stored(env, sub.operationId);
    const engine = containerOf(env.aio).engine();
    // `update` never moves a terminal Operation, and appending to one is refused for every
    // purpose but `rebuild` (the one explicit exception).
    await expect(engine.update(expired, { state: 'submitted' })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    const internal = engine as unknown as {
      appendSigned(...args: unknown[]): Promise<OperationRecord>;
    };
    const attempt = expired.attempts[0] as AttemptRecord;
    await expect(
      internal.appendSigned(
        await targetOf(env),
        expired,
        attempt.unsigned,
        [],
        'replacement',
        attempt.id,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await stored(env, sub.operationId)).toMatchObject({
      state: 'expired',
      version: expired.version,
    });
  });
});
