import { secp256k1 } from '@noble/curves/secp256k1';
import { internalsOf } from '../../../src/core/blockchain/internal';
import { containerOf } from '../../../src/core/container/internals';
import type { ProofSource } from '../../../src/core/driver/types';
import type { OperationTarget } from '../../../src/core/lifecycle/engine';
import type { FeeSpeed } from '../../../src/core/model/fee';
import { secret } from '../../../src/core/secret/secret';
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
import { signFake } from '../../../src/testing/fake-chain';
import { settle, type FakeClock } from '../../../src/testing/fake-clock';
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

type RacedMethod = 'appendAttempt' | 'update';

/**
 * Writes `patch` to the Operation right before the next matching store write (as a worker's
 * claim or a monitor pass does), so that write loses its compare-and-set. One-shot races;
 * `state` narrows an `update` race to patches moving the Operation to that state.
 */
class RacingStore extends MemoryOperationStore {
  races: { method: RacedMethod; patch: OperationPatch; state?: string }[] = [];

  raceBefore(method: RacedMethod, patch: OperationPatch, state?: string): void {
    this.races.push({ method, patch, ...(state ? { state } : {}) });
  }

  async runRace(
    method: RacedMethod,
    namespace: string,
    id: string,
    patch: OperationPatch,
  ): Promise<void> {
    const index = this.races.findIndex(
      (r) => r.method === method && (r.state === undefined || r.state === patch.state),
    );
    const [race] = index < 0 ? [] : this.races.splice(index, 1);
    const current = race ? await this.get(namespace, id) : null;
    if (race && current) await super.update(namespace, id, race.patch, current.version);
  }

  override async update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    await this.runRace('update', namespace, id, patch);
    return super.update(namespace, id, patch, expectedVersion, fence);
  }

  override async appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    await this.runRace('appendAttempt', namespace, id, patch);
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

/**
 * Records `state` on an Attempt's observation, as if a resend's refusal or rejection had
 * been written without the restore that follows it.
 */
async function markObservation(
  env: FakeEnv,
  attemptId: string,
  state: 'refused' | 'rejected',
): Promise<void> {
  const observation = await env.stores.operations.getObservation(attemptId);
  if (!observation) throw new Error(`attempt ${attemptId} was never observed`);
  const { version, ...fields } = observation;
  await env.stores.operations.putObservation(
    { ...fields, state, evidence: state === 'rejected' ? 'proven' : 'observed' },
    version,
  );
}

/** The pooled driver's proofs; a test stubs one by assignment and restores it after. */
async function proofsOf(env: FakeEnv): Promise<ProofSource> {
  return (await internalsOf(env.bc).pooled()).driver.proofs;
}

/**
 * I4: the fake never proves a seqno transaction expired, so its expiry proof is stubbed to
 * say so while the monitor proves the dropped transfer expired, then restored.
 */
async function expiredSeqnoTransfer(env: FakeEnv, recipient: string) {
  const proofs = await proofsOf(env);
  const expired = proofs.expired;
  const sub = await env.run(env.bc.transfer({ to: recipient, amount: 7n }));
  env.chain.dropFromMempool(sub.attempt?.id ?? '');
  proofs.expired = async () => true;
  try {
    await expect(
      mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
  } finally {
    proofs.expired = expired;
  }
  return sub;
}

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
    // M4: the losing original is linked to the cancel that consumed its slot.
    expect(
      await env.stores.operations.getObservation(sub.attempts[0]?.id ?? ''),
    ).toMatchObject({
      state: 'replaced',
      evidence: 'proven',
      replacedBy: cancelled.attempt?.id,
    });
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
    // M4: the refused cancel is proven replaced by the original that won.
    expect(
      await env.stores.operations.getObservation(op?.attempts[1]?.id ?? ''),
    ).toMatchObject({
      state: 'replaced',
      evidence: 'proven',
      replacedBy: sub.attempt?.id,
    });
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
    // M4: the refused replacement is proven replaced by the original that won.
    expect(
      await env.stores.operations.getObservation(op.attempts[1]?.id ?? ''),
    ).toMatchObject({ state: 'replaced', evidence: 'proven', replacedBy: original });
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

  // M4 (R22): a pending answer that arrives after the deadline still holds a live approval.
  it('cancels the ticket of a replacement signer that answers pending after the deadline', async () => {
    const cancelled: string[] = [];
    const late: { answer?: (result: SigningResult) => void } = {};
    const { signer } = purposeSigner(
      () =>
        new Promise<SigningResult>((resolve) => {
          late.answer = resolve;
        }),
      cancelled,
    );
    const env = await createFakeEnv({ signer, lifecycle: { signTimeoutMs: 5_000 } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' }), 1_000),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled).toEqual([]);
    late.answer?.({ status: 'pending', ticket: 'job-late' });
    await settle();
    expect(cancelled).toEqual(['job-late']);
    const op = await stored(env, sub.operationId);
    expect(op.attempts).toHaveLength(1);
    expect(op.signerTickets).toBeUndefined();
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
    store.raceBefore('appendAttempt', { nextCheckAt: env.clock.now() });
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
    store.raceBefore('appendAttempt', { state: 'included' });
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

  // I2: a resumed Attempt the node refuses is undone like a fresh one.
  it('restores the superseded attempt when a resumed replacement is refused', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    // The driver asks for a 10% bump; this node wants 50%.
    const env = await createFakeEnv({
      stores: { operations: faulty },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    await expect(
      restarted.run(restarted.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    // The dead generation's stores never settle: read through the restarted one.
    const op = await stored(restarted, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.error).toBeUndefined();
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(true);
  });

  // M3: the refusal is reported even when the Operation moved on before it was recorded.
  it('reports a refusal and restores the active attempt when the operation moved on', async () => {
    const store = new RacingStore();
    const env = await createFakeEnv({
      stores: { operations: store },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    // The monitor records the original as mined just before the refusal is written.
    store.raceBefore('update', { state: 'included' }, 'stalled');
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await stored(env, sub.operationId);
    // The state is the monitor's; only the active Attempt goes back.
    expect(op).toMatchObject({ state: 'included', activeAttemptId: op.attempts[0]?.id });
  });

  // M2: the restore returns to the snapshot the append was made over, not an older read.
  it('restores the state the refused attempt was appended over', async () => {
    const store = new RacingStore();
    const env = await createFakeEnv({
      stores: { operations: store },
      chain: { minFee: 10n },
    });
    await expect(
      env.run(
        env.bc.transfer(
          { to: env.stranger(), amount: 7n, fee: { fee: 1n } },
          { idempotencyKey: 'cheap' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const id = (await env.stores.operations.getByKey('default', 'cheap'))?.id ?? '';
    // While the replacement is signed, the Operation leaves `stalled` (e.g. a monitor pass).
    store.raceBefore('appendAttempt', { state: 'submitted', clear: ['error'] });
    // Above the driver's 10% bump, below the node's minimum fee: refused.
    await expect(env.run(env.bc.replace(id, { fee: { fee: 2n } }))).rejects.toMatchObject(
      { code: 'FEE_TOO_LOW' },
    );
    const op = await stored(env, id);
    expect(op.attempts).toHaveLength(2);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
    expect(op.error).toBeUndefined();
  });

  // N1: a replacement refused on a resend (recovery) is never reported as a success.
  it('restores and reports a replacement that recovery resent and the node refused', async () => {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    // The driver asks for a 10% bump; this node wants 50%.
    const env = await createFakeEnv({
      signer,
      stores: { operations: faulty },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    await restarted.run(restarted.aio.operations.recover());
    const recovered = await stored(restarted, sub.operationId);
    expect(recovered.activeAttemptId).toBe(recovered.attempts[0]?.id);
    await expect(
      restarted.run(restarted.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await stored(restarted, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(op.activeAttemptId).toBe(op.attempts[0]?.id);
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(true);
    // The same request is answered from its stored bytes: never signed twice.
    expect(calls()).toBe(2);
  });

  it('restores the original when a same-key transfer resends a refused replacement', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({
      stores: { operations: faulty },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const intent = { to: env.stranger(), amount: 7n, fee: 'slow' as const };
    const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'k' }));
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    await expect(
      restarted.run(restarted.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await stored(restarted, sub.operationId);
    expect(op).toMatchObject({ state: 'submitted', activeAttemptId: op.attempts[0]?.id });
  });

  // N2: a refused resend keeps a refused original `stalled`, with its error.
  it('keeps the operation stalled when the superseded original was itself refused', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({
      stores: { operations: faulty },
      chain: { minFee: 10n },
    });
    await expect(
      env.run(
        env.bc.transfer(
          { to: env.stranger(), amount: 7n, fee: { fee: 1n } },
          { idempotencyKey: 'cheap' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const id = (await env.stores.operations.getByKey('default', 'cheap'))?.id ?? '';
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    // Above the driver's 10% bump, below the node's minimum fee.
    await expect(
      env.run(env.bc.replace(id, { fee: { fee: 2n } })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    await expect(
      restarted.run(restarted.bc.replace(id, { fee: { fee: 2n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await stored(restarted, id);
    expect(op).toMatchObject({
      state: 'stalled',
      activeAttemptId: op.attempts[0]?.id,
      error: expect.objectContaining({ code: 'FEE_TOO_LOW' }),
    });
  });

  // M-b: a terminal Operation keeps its active Attempt.
  it('leaves a terminal operation alone when a refusal arrives after it ended', async () => {
    const store = new RacingStore();
    const env = await createFakeEnv({
      stores: { operations: store },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    // The monitor records the original final just before the refusal is written.
    store.raceBefore(
      'update',
      { state: 'final', outcome: 'executed', clear: ['nextCheckAt'] },
      'stalled',
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await stored(env, sub.operationId);
    expect(op).toMatchObject({ state: 'final', activeAttemptId: op.attempts[1]?.id });
  });

  it('never replaces a cancel, and returns a cancel already on chain on a repeat', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const first = await env.run(env.bc.cancel(sub.operationId));
    // A replacement would be built from the cancel's self-transfer, yet report `executed`.
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 100n } })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const again = await env.run(env.bc.cancel(sub.operationId));
    expect(again).toMatchObject({ state: 'included', attempt: first.attempt });
    expect(again.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
    expect(calls()).toBe(2);
  });

  // I1 / R30: a cancel that cannot land is bumped by a repeat, so the nonce never sticks.
  it('bumps a dropped cancel on a repeat and settles on the bumped one', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: 7n, fee: 'slow' }),
    );
    const first = await env.run(env.bc.cancel(sub.operationId));
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(false);
    // The node's minimum fee rises above the cancel's, and the cancel is evicted.
    (env.chain as { minFee: bigint }).minFee = 3n;
    env.chain.dropFromMempool(first.attempt?.id ?? '');
    // R30.1: only once the monitor has seen it dropped does a repeat bump it.
    expect(
      (await env.run(env.bc.cancel(sub.operationId))).attempts.map((a) => a.purpose),
    ).toEqual(['original', 'cancel']);
    await env.clock.advance(11_000);
    await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(
      await env.stores.operations.getObservation(first.attempts[1]?.id ?? ''),
    ).toMatchObject({ state: 'dropped' });
    const again = await env.run(env.bc.cancel(sub.operationId));
    expect(again.attempts.map((a) => a.purpose)).toEqual([
      'original',
      'cancel',
      'cancel',
    ]);
    expect(again.attempt?.id).not.toBe(first.attempt?.id);
    expect(env.chain.inMempool(again.attempt?.id ?? '')).toBe(true);
    expect(calls()).toBe(3);
    const final = await mineWhile(env, again.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect(env.chain.balance(recipient)).toBe(0n);
  });

  it('cancels at an explicit fee, refusing one below the bump before signing', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.cancel(sub.operationId, { fee: { fee: 1n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    await expect(
      env.run(env.bc.cancel(sub.operationId, { fee: { fee: 5 } })),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    expect(calls()).toBe(1);
    const cancelled = await env.run(env.bc.cancel(sub.operationId, { fee: { fee: 9n } }));
    expect(env.chain.inMempool(cancelled.attempt?.id ?? '')).toBe(true);
    const op = await stored(env, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
    expect(op.attempts[1]?.fee.charges).toEqual([
      { asset: 'native', amount: 9n, label: 'network' },
    ]);
    expect(calls()).toBe(2);
  });

  // N4 / R30.1: concurrent or retried cancels are idempotent while the cancel is pending.
  it('creates one cancel for concurrent cancels, and a new one only at an explicit fee', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const [a, b] = await env.run(
      Promise.all([env.bc.cancel(sub.operationId), env.bc.cancel(sub.operationId)]),
    );
    expect(a.attempt).toEqual(b.attempt);
    expect(b.attempts.map((x) => x.purpose)).toEqual(['original', 'cancel']);
    expect(calls()).toBe(2);
    // An explicit fee always asks for a new cancel while none is on chain.
    const raised = await env.run(env.bc.cancel(sub.operationId, { fee: { fee: 9n } }));
    expect(raised.attempts.map((x) => x.purpose)).toEqual([
      'original',
      'cancel',
      'cancel',
    ]);
    expect(env.chain.inMempool(raised.attempt?.id ?? '')).toBe(true);
    expect(calls()).toBe(3);
  });

  // N3: bumps climb from the highest-fee earlier cancel, never re-signing an identical one.
  it('bumps from the highest-fee earlier cancel after a refused one gave the active role back', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: 7n, fee: 'slow' }),
    );
    const first = await env.run(env.bc.cancel(sub.operationId));
    // The floor rises and the cancel is evicted: resending it is refused.
    (env.chain as { minFee: bigint }).minFee = 3n;
    env.chain.dropFromMempool(first.attempt?.id ?? '');
    await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
      code: 'FEE_TOO_LOW',
    });
    const restored = await stored(env, sub.operationId);
    expect(restored.activeAttemptId).toBe(restored.attempts[0]?.id);
    const again = await env.run(env.bc.cancel(sub.operationId));
    const op = await stored(env, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel', 'cancel']);
    expect(op.attempts[2]?.fee.charges[0]?.amount).toBe(3n);
    expect(env.chain.inMempool(again.attempt?.id ?? '')).toBe(true);
    expect(calls()).toBe(3);
    const final = await mineWhile(env, again.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect(env.chain.balance(recipient)).toBe(0n);
  });

  // N1 / R30.1: an active cancel recorded as refused gives the active role back, then is bumped.
  // R30.2: a rejected active cancel is treated exactly like a refused one.
  it.each(['refused', 'rejected'] as const)(
    'restores the superseded attempt before bumping an active cancel recorded as %s',
    async (state) => {
      const env = await createFakeEnv();
      const sub = await env.run(
        env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
      );
      const first = await env.run(env.bc.cancel(sub.operationId));
      await markObservation(env, first.attempts[1]?.id ?? '', state);
      const again = await env.run(env.bc.cancel(sub.operationId));
      const op = await stored(env, sub.operationId);
      expect(op.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel', 'cancel']);
      expect(op.attempts[2]?.supersedes).toBe(op.attempts[0]?.id);
      expect(env.chain.inMempool(again.attempt?.id ?? '')).toBe(true);
    },
  );

  // R30.2: a rejected active replacement is resent like a refused one, never a success.
  it('resends an active replacement recorded as rejected and reports the refusal', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const replaced = await env.run(env.bc.replace(sub.operationId, { fee: 'fast' }));
    await markObservation(env, replaced.attempts[1]?.id ?? '', 'rejected');
    env.chain.dropFromMempool(replaced.attempt?.id ?? '');
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast;
    driver.broadcaster.broadcast = async () => ({
      kind: 'rejected',
      reason: 'invalid signature',
    });
    try {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
      ).rejects.toMatchObject({ code: 'TX_REFUSED' });
    } finally {
      driver.broadcaster.broadcast = broadcast;
    }
    const op = await stored(env, sub.operationId);
    expect(op.attempts).toHaveLength(2);
    expect(op.activeAttemptId).toBe(op.attempts[0]?.id);
    expect(calls()).toBe(2);
  });

  // R2-1: a cancel after a newer, higher replacement is built from that replacement.
  it('builds a cancel from a newer replacement that pays more than an earlier cancel', async () => {
    const env = await createFakeEnv({ chain: { minFee: 10n } });
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: 7n, fee: 'slow' }),
    );
    // The floor rises: the cancel (fee 11) is refused and the original stays active.
    (env.chain as { minFee: bigint }).minFee = 20n;
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'FEE_TOO_LOW',
    });
    (env.chain as { minFee: bigint }).minFee = 10n;
    await env.run(env.bc.replace(sub.operationId, { fee: { fee: 100n } }));
    const cancelled = await env.run(env.bc.cancel(sub.operationId));
    const op = await stored(env, sub.operationId);
    expect(op.attempts.map((a) => a.purpose)).toEqual([
      'original',
      'cancel',
      'replacement',
      'cancel',
    ]);
    expect(op.attempts[3]?.fee.charges[0]?.amount).toBe(110n);
    expect(env.chain.inMempool(cancelled.attempt?.id ?? '')).toBe(true);
    const final = await mineWhile(env, cancelled.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect(env.chain.balance(recipient)).toBe(0n);
  });

  // R2-2: a refused replacement is made active again only after the node accepted it.
  it('reactivates a refused replacement only after the node accepts its resend', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    // The driver asks for a 10% bump; this node wants 50% at first.
    const env = await createFakeEnv({
      stores: { operations: faulty },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const refused = (await stored(env, sub.operationId)).attempts[1] as AttemptRecord;
    // The node relaxes; the process dies right after making the replacement active again.
    (env.chain as { bumpPercent: bigint }).bumpPercent = 10n;
    faulty.crashOn({
      method: 'update',
      timing: 'after',
      when: (args) =>
        (args[2] as OperationPatch | undefined)?.activeAttemptId === refused.id,
    });
    // R3-1: the node accepted the resend, so the crash surfaces as ambiguous.
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
    const restarted = await env.restart({ killPrevious: true });
    await restarted.run(restarted.aio.operations.recover());
    const op = await stored(restarted, sub.operationId);
    // Active only once accepted: the replacement is live, and the original was evicted.
    expect(op.activeAttemptId).toBe(refused.id);
    expect(env.chain.inMempool(refused.ref.id)).toBe(true);
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(false);
  });

  // R3-1 (R27): once the node accepted a restored-away resend, a failure is ambiguous.
  it('reports a failure after an accepted restored-away resend as STATE_UNRECORDED', async () => {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    // The driver asks for a 10% bump; this node wants 50% at first.
    const env = await createFakeEnv({
      signer,
      stores: { operations: faulty },
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const refused = (await stored(env, sub.operationId)).attempts[1] as AttemptRecord;
    const signed = calls();
    // The node relaxes; the store write that swaps the active Attempt fails once.
    (env.chain as { bumpPercent: bigint }).bumpPercent = 10n;
    faulty.crashOn({
      method: 'update',
      timing: 'before',
      when: (args) =>
        (args[2] as OperationPatch | undefined)?.activeAttemptId === refused.id,
    });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({
      code: 'STATE_UNRECORDED',
      ambiguous: true,
      retryable: true,
      details: { causeCode: 'UNKNOWN' },
      context: { operationId: sub.operationId, attemptId: refused.id },
    });
    expect(env.chain.inMempool(refused.ref.id)).toBe(true);
    const again = await env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } }));
    expect(again.attempt?.id).toBe(refused.ref.id);
    const op = await stored(env, sub.operationId);
    expect(op.activeAttemptId).toBe(refused.id);
    expect(op.attempts).toHaveLength(2);
    expect(calls()).toBe(signed);
  });

  // R31 (R27): a failed own-ref lookup after a restored-away refusal is ambiguous.
  it('reports a failed own-ref lookup after a restored-away refusal as STATE_UNRECORDED', async () => {
    // The driver asks for a 10% bump; this node wants 50%.
    const env = await createFakeEnv({
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const refused = (await stored(env, sub.operationId)).attempts[1] as AttemptRecord;
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast;
    const observe = driver.reader.observe;
    driver.broadcaster.broadcast = async () => ({
      kind: 'refused',
      code: 'FEE_TOO_LOW',
      reason: 'replacement transaction underpriced',
    });
    driver.reader.observe = async () => {
      throw new Error('lookup failed');
    };
    try {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
      ).rejects.toMatchObject({
        code: 'STATE_UNRECORDED',
        ambiguous: true,
        details: { causeCode: 'PROVIDER_UNAVAILABLE' },
        context: { operationId: sub.operationId, attemptId: refused.id },
      });
    } finally {
      driver.broadcaster.broadcast = broadcast;
      driver.reader.observe = observe;
    }
    const op = await stored(env, sub.operationId);
    expect(op.activeAttemptId).toBe(op.attempts[0]?.id);
    expect(op.attempts).toHaveLength(2);
  });

  // R3-2 (R25): a rejected restored-away resend is a refusal once a node accepted the bytes.
  it('reports a rejected restored-away resend as refused when a node once accepted it', async () => {
    const env = await createFakeEnv({ chain: { minFee: 10n } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    const replaced = await env.run(
      env.bc.replace(sub.operationId, { fee: { fee: 12n } }),
    );
    const accepted = replaced.attempts[1] as AttemptRecord;
    // The accepted replacement is dropped and its resend refused: it gives the role back.
    await markObservation(env, accepted.id, 'refused');
    env.chain.dropFromMempool(accepted.ref.id);
    (env.chain as { minFee: bigint }).minFee = 20n;
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    expect((await stored(env, sub.operationId)).activeAttemptId).toBe(
      replaced.attempts[0]?.id,
    );
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast;
    driver.broadcaster.broadcast = async () => ({
      kind: 'rejected',
      reason: 'invalid signature',
    });
    try {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
      ).rejects.toMatchObject({ code: 'TX_REFUSED', ambiguous: false });
    } finally {
      driver.broadcaster.broadcast = broadcast;
    }
    const op = await stored(env, sub.operationId);
    expect(op.activeAttemptId).toBe(op.attempts[0]?.id);
    expect(op.attempts).toHaveLength(2);
  });

  // R3-2: bytes no node ever accepted keep the rejection's own code.
  it('reports a rejected restored-away resend as rejected when no node accepted it', async () => {
    // The driver asks for a 10% bump; this node wants 50%.
    const env = await createFakeEnv({
      chain: { minFee: 10n, replacementBumpPercent: 50 },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast;
    driver.broadcaster.broadcast = async () => ({
      kind: 'rejected',
      reason: 'invalid signature',
    });
    try {
      await expect(
        env.run(env.bc.replace(sub.operationId, { fee: { fee: 12n } })),
      ).rejects.toMatchObject({ code: 'TX_REJECTED', ambiguous: false });
    } finally {
      driver.broadcaster.broadcast = broadcast;
    }
    const op = await stored(env, sub.operationId);
    expect(op.activeAttemptId).toBe(op.attempts[0]?.id);
  });

  // I3 / R30: replace is idempotent per fee spec; another spec is another request.
  it('returns the existing replacement for the same fee spec after a crash', async () => {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createFakeEnv({ signer, stores: { operations: faulty } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 7n, fee: 'slow' }),
    );
    faulty.crashOn({
      method: 'update',
      timing: 'after',
      when: (args) => (args[2] as OperationPatch | undefined)?.state === 'submitted',
    });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
    const restarted = await env.restart({ killPrevious: true });
    const again = await restarted.run(
      restarted.bc.replace(sub.operationId, { fee: 'fast' }),
    );
    expect(again.state).toBe('submitted');
    expect(again.attempts.map((a) => a.purpose)).toEqual(['original', 'replacement']);
    expect(calls()).toBe(2);
    // An equal override written differently is the same spec; a higher one is a new request.
    const bumped = await restarted.run(
      restarted.bc.replace(sub.operationId, { fee: { fee: 10n } }),
    );
    const repeat = await restarted.run(
      restarted.bc.replace(sub.operationId, { fee: { fee: 10n } }),
    );
    expect(repeat.attempts.map((a) => a.purpose)).toEqual([
      'original',
      'replacement',
      'replacement',
    ]);
    expect(repeat.attempt).toEqual(bumped.attempt);
    expect(env.chain.inMempool(bumped.attempt?.id ?? '')).toBe(true);
    expect(calls()).toBe(3);
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

  // I4 + M1: seqno chains.
  it('rebuilds an expired seqno transfer on the same seqno and refreshes its reservation', async () => {
    const env = await createFakeEnv({
      ordering: 'seqno',
      lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    });
    const recipient = env.stranger();
    const sub = await expiredSeqnoTransfer(env, recipient);
    const proofs = await proofsOf(env);
    const expired = proofs.expired;
    proofs.expired = async () => true;
    let rebuilt;
    try {
      rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    } finally {
      proofs.expired = expired;
    }
    expect(rebuilt.attempts.map((a) => a.purpose)).toEqual(['original', 'rebuild']);
    const op = await stored(env, sub.operationId);
    const [original, rebuild] = op.attempts;
    expect(rebuild?.ordering).toMatchObject({ kind: 'seqno', seqno: 0n });
    expect(op.reservation).toEqual(rebuild?.ordering);
    expect(op.reservation).not.toEqual(original?.ordering);
    const final = await mineWhile(env, rebuilt.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  it('proves a consumed seqno dead before the inclusion check and rebuilds on the next one', async () => {
    const key = secp256k1.utils.randomPrivateKey();
    const env = await createFakeEnv({
      ordering: 'seqno',
      signer: localSigner({ id: 'hot', secp256k1: secret(key) }),
      lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    });
    const recipient = env.stranger();
    const sub = await expiredSeqnoTransfer(env, recipient);
    // Another transaction takes seqno 0, and it is finalized.
    env.chain.submit(
      signFake(
        {
          chainId: 'fake-local',
          from: env.address,
          to: env.stranger(),
          amount: '1',
          fee: '1',
          nonce: '0',
        },
        key,
      ),
    );
    env.chain.mine(5);
    const proofs = await proofsOf(env);
    const real = { ...proofs };
    const reads: string[] = [];
    proofs.expired = async (ordering) => {
      reads.push('expired');
      return real.expired(ordering);
    };
    proofs.slotConsumed = async (ordering, from, level) => {
      reads.push(`slotConsumed:${level}`);
      return real.slotConsumed(ordering, from, level);
    };
    proofs.includedFinal = async (ref, ordering, from) => {
      reads.push('includedFinal');
      return real.includedFinal(ref, ordering, from);
    };
    let rebuilt;
    try {
      rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    } finally {
      Object.assign(proofs, real);
    }
    expect(reads).toEqual(['expired', 'slotConsumed:finalized', 'includedFinal']);
    const op = await stored(env, sub.operationId);
    expect(op.attempts[1]?.ordering).toMatchObject({ kind: 'seqno', seqno: 1n });
    expect(op.reservation).toEqual(op.attempts[1]?.ordering);
    const final = await mineWhile(env, rebuilt.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.chain.balance(recipient)).toBe(7n);
  });

  it('refuses to rebuild while another operation holds the wallet’s seqno', async () => {
    const env = await createFakeEnv({
      ordering: 'seqno',
      lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    });
    const sub = await expiredSeqnoTransfer(env, env.stranger());
    const other = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const proofs = await proofsOf(env);
    const expired = proofs.expired;
    proofs.expired = async () => true;
    try {
      await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
        code: 'SEQUENCE_BUSY',
        context: expect.objectContaining({ blockingOperationId: other.operationId }),
      });
    } finally {
      proofs.expired = expired;
    }
    expect(await stored(env, sub.operationId)).toMatchObject({
      state: 'expired',
      attempts: [expect.objectContaining({ purpose: 'original' })],
    });
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
