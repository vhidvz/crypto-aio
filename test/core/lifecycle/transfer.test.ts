import { secp256k1 } from '@noble/curves/secp256k1';
import { createLogger, type LogLevel } from '../../../src/core/events/logger';
import { withLifecycleDefaults } from '../../../src/core/lifecycle/engine';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer, SigningResult } from '../../../src/core/signing/types';
import { MemoryLockManager, MemoryOperationStore } from '../../../src/core/store/memory';
import type { LockManager, OperationStore } from '../../../src/core/store/types';
import { toHex } from '../../../src/core/util/bytes';
import { fakeAddress, signFake } from '../../../src/testing/fake-chain';
import { createFakeEnv, type FakeEnvOptions } from '../../../src/testing/env';
import { FakeClock, settle } from '../../../src/testing/fake-clock';
import { ctx } from '../signing/fixtures';
import { countingSigner } from './support';

const nonceOf = async (env: Awaited<ReturnType<typeof createFakeEnv>>, id: string) => {
  const reservation = (await env.stores.operations.get('default', id))?.reservation;
  return reservation?.kind === 'nonce' ? reservation.nonce : undefined;
};

function captureLogs() {
  const logs: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] =
    [];
  const logger = createLogger('test', (level, _ns, message, fields) =>
    logs.push({ level, message, ...(fields ? { fields } : {}) }),
  );
  return { logs, logger };
}

/** An asynchronous (MPC-style) signer: every request answers `pending` with `ticket`. */
function asyncSigner(ticket: string, cancelled: string[] = []) {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'mpc' }).signer;
  const signer = callbackSigner({
    id: 'hot',
    schemes: ['secp256k1-ecdsa'],
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async () => ({ status: 'pending', ticket }),
    cancelRequest: async (issued) => {
      cancelled.push(issued);
    },
  });
  return { inner, signer };
}

/** Signs the request of a prepared Operation outside the library. */
async function externalSignature(
  env: Awaited<ReturnType<typeof createFakeEnv>>,
  inner: Signer,
  idempotencyKey: string,
  intent: { to: string; amount: bigint },
) {
  const prepared = await env.run(env.bc.prepareTransfer(intent, { idempotencyKey }));
  const result = await inner.sign(prepared.unsigned?.signingRequests ?? [], ctx);
  if (result.status !== 'signed') throw new Error('unreachable');
  const [signature] = result.signatures;
  if (!signature) throw new Error('unreachable');
  return signature;
}

describe('transfer', () => {
  it('signs, persists and broadcasts a transfer', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    const sub = await env.run(
      env.bc.transfer({ to: recipient, amount: '0.0000001' }, { idempotencyKey: 't-1' }),
    );
    expect(sub.state).toBe('submitted');
    expect(sub.attempt?.idKind).toBe('tx-hash');
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(true);
    expect(
      (await env.stores.operations.get('default', sub.operationId))?.attempts[0]?.raw
        .encoding,
    ).toBe('base64');
    env.chain.mine();
    expect(env.chain.balance(recipient)).toBe(10n);
  });

  it.each(['expiry', 'seqno'] as const)(
    'signs, persists and broadcasts on a %s-ordered chain',
    async (ordering) => {
      const env = await createFakeEnv({ ordering });
      const sub = await env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'o-1' }),
      );
      expect(sub.state).toBe('submitted');
      env.chain.mine();
      expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
    },
  );

  // Review Focus 3 (end to end): concurrent transfers get distinct nonces and all land.
  it('gives concurrent transfers from one wallet distinct nonces and lands them all', async () => {
    const env = await createFakeEnv();
    const subs = await env.run(
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          env.bc.transfer(
            { to: env.stranger(), amount: BigInt(i + 1) },
            { idempotencyKey: `c-${i}` },
          ),
        ),
      ),
      10,
    );
    const nonces = await Promise.all(subs.map((s) => nonceOf(env, s.operationId)));
    expect(nonces.map(String).sort()).toEqual(['0', '1', '2', '3', '4']);
    env.chain.mine();
    for (const s of subs)
      expect(env.chain.receipt(s.attempt?.id ?? '')?.success).toBe(true);
  });

  it('returns the same operation on retry without signing or sending again', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const intent = { to: env.stranger(), amount: 3n };
    const first = await env.run(env.bc.transfer(intent, { idempotencyKey: 'again' }));
    const second = await env.run(env.bc.transfer(intent, { idempotencyKey: 'again' }));
    expect(second.operationId).toBe(first.operationId);
    expect(calls()).toBe(1);
    expect(env.chain.sendCount(first.attempt?.id ?? '')).toBe(1);
  });

  it('stalls on a refused broadcast, keeps the nonce and resumes on rebroadcast', async () => {
    const env = await createFakeEnv();
    const stalled: string[] = [];
    env.aio.on('operation.stalled', (e) => stalled.push(e.code));
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    const intent = { to: env.stranger(), amount: 3n };
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 's-1' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const op = await env.stores.operations.getByKey('default', 's-1');
    expect(op?.state).toBe('stalled');
    expect(stalled).toEqual(['INSUFFICIENT_FUNDS']);
    expect(
      (await env.stores.operations.getObservation(op?.activeAttemptId ?? ''))?.state,
    ).toBe('refused');
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 's-1' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const next = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 's-2' }),
    );
    expect(await nonceOf(env, next.operationId)).toBe(1n);
    const resumed = await env.run(env.bc.rebroadcast(op?.id ?? ''));
    expect(resumed.state).toBe('submitted');
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(2n);
  });

  it('fails and frees the nonce when the node rejects the transaction as invalid', async () => {
    const env = await createFakeEnv();
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'r-1' }),
      ),
    ).rejects.toMatchObject({ code: 'TX_REJECTED' });
    const op = await env.stores.operations.getByKey('default', 'r-1');
    expect(op?.state).toBe('failed');
    expect(
      await env.stores.operations.getObservation(op?.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'rejected', evidence: 'proven' });
    const next = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 'r-2' }),
    );
    expect(await nonceOf(env, next.operationId)).toBe(0n);
  });

  it('marks an unacknowledged broadcast ambiguous and resolves it on retry', async () => {
    const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    const intent = { to: env.stranger(), amount: 3n };
    const error = await env
      .run(env.bc.transfer(intent, { idempotencyKey: 'amb' }))
      .catch((e: unknown) => e);
    // R28: `ambiguous` carries the retry guidance; the code keeps its catalogue retryability.
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      ambiguous: true,
      retryable: true,
      context: expect.objectContaining({ operationId: expect.any(String) }),
    });
    const op = await env.stores.operations.getByKey('default', 'amb');
    expect(op).toMatchObject({ state: 'submitted', ambiguous: true });
    const ref = op?.attempts[0]?.ref.id ?? '';
    expect(env.chain.inMempool(ref)).toBe(true);
    const retried = await env.run(env.bc.transfer(intent, { idempotencyKey: 'amb' }));
    expect(retried.ambiguous).toBe(false);
    expect(env.chain.sendCount(ref)).toBe(2);
  });

  // Carry-forward (Plans 2-6 rule, engine side): an RPC error that follows a possibly
  // delivered attempt is ambiguous even when its message reads like a rejection.
  it('keeps an ambiguous RPC error ambiguous instead of failing and freeing the nonce', async () => {
    const env = await createFakeEnv();
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    // After the first (possibly delivered) send fails, the transport's retry is answered
    // with a message that would classify as `rejected` if it were taken at face value.
    const off = env.aio.on('rpc.error', (e) => {
      if (e.method !== 'fake_sendRawTransaction') return;
      off();
      env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    });
    const intent = { to: env.stranger(), amount: 3n };
    const error = await env
      .run(env.bc.transfer(intent, { idempotencyKey: 'amb-rpc' }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      ambiguous: true,
      retryable: false,
      context: expect.objectContaining({ operationId: expect.any(String) }),
    });
    const op = await env.stores.operations.getByKey('default', 'amb-rpc');
    expect(op).toMatchObject({ state: 'submitted', ambiguous: true });
    expect(op?.nextCheckAt).toBeDefined();
    expect(
      (await env.stores.operations.getObservation(op?.activeAttemptId ?? ''))?.state,
    ).toBe('pending');
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, next.operation.id)).toBe(1n);
    const retried = await env.run(env.bc.transfer(intent, { idempotencyKey: 'amb-rpc' }));
    expect(retried).toMatchObject({ state: 'submitted', ambiguous: false });
  });

  // Carry-forward: the transport surfaces a caller abort as the bare reason, even after a
  // possibly delivered attempt. The engine must still treat it as ambiguous.
  it('treats a broadcast aborted by the caller as ambiguous, monitored and still reserved', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    const controller = new AbortController();
    env.aio.on('rpc.error', (e) => {
      if (e.method === 'fake_sendRawTransaction') controller.abort(new Error('gave up'));
    });
    const intent = { to: env.stranger(), amount: 3n };
    const error = await env
      .run(
        env.bc.transfer(intent, { idempotencyKey: 'abort', signal: controller.signal }),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      ambiguous: true,
      retryable: true,
      context: expect.objectContaining({ operationId: expect.any(String) }),
    });
    const op = await env.stores.operations.getByKey('default', 'abort');
    expect(op).toMatchObject({ state: 'submitted', ambiguous: true });
    expect(op?.nextCheckAt).toBeDefined();
    const ref = op?.attempts[0]?.ref.id ?? '';
    expect(env.chain.inMempool(ref)).toBe(true);
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, next.operation.id)).toBe(1n);
    const retried = await env.run(env.bc.transfer(intent, { idempotencyKey: 'abort' }));
    expect(retried).toMatchObject({ state: 'submitted', ambiguous: false });
    expect(retried.attempt?.id).toBe(ref);
    expect(calls()).toBe(1);
  });

  it('waits for asynchronous signers and completes with submitted signatures', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'mpc' }).signer;
    const mpc = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async () => ({ status: 'pending', ticket: 'job-1' }),
    });
    const env = await createFakeEnv({ signer: mpc });
    const intent = { to: env.stranger(), amount: 3n };
    const pending = await env.run(env.bc.transfer(intent, { idempotencyKey: 'mpc-1' }));
    expect(pending.state).toBe('awaiting-signature');
    const other = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: 'mpc-2' }),
    );
    expect(await nonceOf(env, other.operationId)).toBe(1n);
    const prepared = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'mpc-1' }),
    );
    const result = await inner.sign(prepared.unsigned?.signingRequests ?? [], ctx);
    if (result.status !== 'signed') throw new Error('unreachable');
    const [signature] = result.signatures;
    if (!signature) throw new Error('unreachable');
    await expect(
      env.run(
        env.bc.submitSignatures(pending.operationId, [
          { ...signature, bytes: new Uint8Array(64) },
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'SIGNATURE_MISMATCH',
    });
    expect((await env.stores.operations.get('default', pending.operationId))?.state).toBe(
      'awaiting-signature',
    );
    const done = await env.run(env.bc.submitSignatures(pending.operationId, [signature]));
    expect(done.state).toBe('submitted');
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(1n);
  });

  it('abandons an awaiting-signature operation, cancels the signer request and frees the nonce', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'mpc' }).signer;
    const cancelled: string[] = [];
    const mpc = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async () => ({ status: 'pending', ticket: 'job-9' }),
      cancelRequest: async (ticket) => {
        cancelled.push(ticket);
      },
    });
    const env = await createFakeEnv({ signer: mpc });
    const pending = await env.run(env.bc.transfer({ to: env.stranger(), amount: 3n }));
    await env.run(env.bc.abandon(pending.operationId));
    expect(cancelled).toEqual(['job-9']);
    const next = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect(await nonceOf(env, next.operationId)).toBe(0n);
  });

  it('broadcasts an externally signed transaction without creating an operation', async () => {
    const key = secp256k1.utils.randomPrivateKey();
    const env = await createFakeEnv();
    const from = fakeAddress(secp256k1.getPublicKey(key, true));
    env.chain.fund(from, 100n);
    const raw = signFake(
      {
        chainId: 'fake-local',
        from,
        to: env.stranger(),
        amount: '1',
        fee: '2',
        nonce: '0',
      },
      key,
    );
    expect(await env.run(env.bc.broadcast({ encoding: 'base64', data: raw }))).toEqual({
      kind: 'accepted',
    });
    expect(await env.stores.operations.list({ namespace: 'default' })).toHaveLength(0);
  });

  it('refuses transfers from watch-only wallets but lets them prepare', async () => {
    const env = await createFakeEnv();
    const publicKey = await env.signer.getPublicKey('secp256k1-ecdsa');
    const cold = env.aio
      .scope({ wallets: { cold: { publicKey: toHex(publicKey) } } })
      .blockchain({ chain: 'fakechain', wallet: 'cold' });
    await expect(
      env.run(cold.transfer({ to: env.stranger(), amount: 1n })),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    const prepared = await env.run(
      cold.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(prepared.unsigned?.signingRequests[0]?.publicKey).toEqual(publicKey);
  });
});

describe('transfer: signing under the address lease', () => {
  /** A signer whose `sign` answers only when the test says so (or never). */
  function manualSigner(cancelled: string[] = []) {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'slow' }).signer;
    let answer: ((result: SigningResult) => void) | undefined;
    const signer = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: () =>
        new Promise<SigningResult>((resolve) => {
          answer = resolve;
        }),
      cancelRequest: async (ticket) => {
        cancelled.push(ticket);
      },
    });
    return { signer, answer: (result: SigningResult) => answer?.(result) };
  }

  // R24 (a): the wait is bounded by lifecycle.signTimeoutMs, not by the lease.
  it('stops waiting for a signer after lifecycle.signTimeoutMs and writes nothing', async () => {
    const { signer } = manualSigner();
    const env = await createFakeEnv({ signer, lifecycle: { signTimeoutMs: 60_000 } });
    const intent = { to: env.stranger(), amount: 3n };
    const started = env.clock.now();
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'hung' }), 1_000),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    const waited = env.clock.now() - started;
    expect(waited).toBeGreaterThanOrEqual(60_000);
    expect(waited).toBeLessThanOrEqual(61_000);
    const op = await env.stores.operations.getByKey('default', 'hung');
    expect(op).toMatchObject({
      state: 'prepared',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    expect(op?.attempts).toHaveLength(0);
    expect(env.clock.pending).toBe(0);
    // The lease was given back: another transfer allocates the next nonce straight away.
    const other = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, other.operation.id)).toBe(1n);
  });

  it('keeps the lease alive for a signer slower than leaseMs', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'slow' }).signer;
    const clock: { current?: FakeClock } = {};
    const slow = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async (requests, signingCtx) => {
        await clock.current?.sleep(45_000);
        return inner.sign(requests, signingCtx);
      },
    });
    const env = await createFakeEnv({
      signer: slow,
      lifecycle: { leaseMs: 30_000, signTimeoutMs: 120_000 },
    });
    clock.current = env.clock;
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'slow' }),
      1_000,
    );
    expect(sub.state).toBe('submitted');
    expect(env.chain.inMempool(sub.attempt?.id ?? '')).toBe(true);
    expect(
      (await env.stores.operations.get('default', sub.operationId))?.attempts,
    ).toHaveLength(1);
    expect(env.clock.pending).toBe(0);
  });

  it('gives up the wait and writes nothing when the lease is lost while the signer works', async () => {
    const { logs, logger } = captureLogs();
    const locks = new MemoryLockManager(new FakeClock());
    let lose = false;
    const flaky: LockManager = {
      acquire: (key, owner, ttlMs) => locks.acquire(key, owner, ttlMs),
      renew: async (lease, ttlMs) => (lose ? null : locks.renew(lease, ttlMs)),
      release: (lease) => locks.release(lease),
    };
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'slow' }).signer;
    const clock: { current?: FakeClock } = {};
    const slow = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async (requests, signingCtx) => {
        lose = true; // another worker takes the address over while this signer works
        await clock.current?.sleep(20_000);
        return inner.sign(requests, signingCtx);
      },
    });
    const env = await createFakeEnv({
      signer: slow,
      stores: { locks: flaky },
      aio: { logger },
    });
    clock.current = env.clock;
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'lost' }),
        1_000,
      ),
    ).rejects.toMatchObject({ code: 'FENCING' });
    const op = await env.stores.operations.getByKey('default', 'lost');
    expect(op).toMatchObject({
      state: 'prepared',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    expect(
      logs.filter(
        (entry) => entry.message === 'address lease lost while waiting for the signer',
      ),
    ).toEqual([
      {
        level: 'warn',
        message: 'address lease lost while waiting for the signer',
        fields: { operationId: op?.id, code: 'FENCING' },
      },
    ]);
    // The signer's late answer is dropped: nothing is persisted from it.
    await env.run(env.clock.sleep(20_000), 1_000);
    expect(await env.stores.operations.getByKey('default', 'lost')).toMatchObject({
      state: 'prepared',
      attempts: [],
    });
  });

  // R24 / R22: a pending answer that arrives after the deadline still has a live ticket.
  it('cancels the ticket of a pending answer that arrives after the deadline', async () => {
    const cancelled: string[] = [];
    const { signer, answer } = manualSigner(cancelled);
    const env = await createFakeEnv({ signer, lifecycle: { signTimeoutMs: 5_000 } });
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'late' }),
        1_000,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled).toEqual([]);
    answer({ status: 'pending', ticket: 'job-1' });
    await settle();
    expect(cancelled).toEqual(['job-1']);
    const op = await env.stores.operations.getByKey('default', 'late');
    expect(op).toMatchObject({ state: 'prepared' });
    expect(op?.signerTickets).toBeUndefined();
  });

  it('rejects an invalid lifecycle.signTimeoutMs', () => {
    for (const signTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withLifecycleDefaults({ signTimeoutMs })).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(withLifecycleDefaults({}).signTimeoutMs).toBe(120_000);
  });

  it('runs submitSignatures under the address lease', async () => {
    const { signer } = asyncSigner('job-1');
    const env = await createFakeEnv({ signer });
    const pending = await env.run(env.bc.transfer({ to: env.stranger(), amount: 3n }));
    const key = sequenceKey('default', 'fakechain', 'local', env.address);
    const intruder = await env.stores.locks.acquire(key, 'intruder', 120_000);
    expect(intruder).not.toBeNull();
    await expect(
      env.run(env.bc.submitSignatures(pending.operationId, []), 1_000),
    ).rejects.toMatchObject({ code: 'SEQUENCE_BUSY' });
  });

  it('re-authorizes on submitSignatures: a veto fails the operation, cancels its tickets and frees the nonce', async () => {
    const cancelled: string[] = [];
    const { inner, signer } = asyncSigner('job-3', cancelled);
    let veto = false;
    const options: FakeEnvOptions = {
      signer,
      hooks: {
        beforeSign: () => {
          if (veto) throw new Error('limit exceeded');
        },
      },
    };
    const env = await createFakeEnv(options);
    const intent = { to: env.stranger(), amount: 3n };
    const pending = await env.run(env.bc.transfer(intent, { idempotencyKey: 'veto' }));
    expect(pending.state).toBe('awaiting-signature');
    const signature = await externalSignature(env, inner, 'veto', intent);
    veto = true;
    await expect(
      env.run(env.bc.submitSignatures(pending.operationId, [signature])),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    const op = await env.stores.operations.get('default', pending.operationId);
    expect(op?.state).toBe('failed');
    expect(op?.attempts).toHaveLength(0);
    expect(cancelled).toEqual(['job-3']);
    veto = false;
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, next.operation.id)).toBe(0n);
  });

  // Carry-forward: a corrupt persisted partial must not make the Operation unrecoverable.
  it('drops a corrupt persisted partial signature when new signatures are submitted', async () => {
    const { inner, signer } = asyncSigner('job-4');
    const env = await createFakeEnv({ signer });
    const intent = { to: env.stranger(), amount: 3n };
    const pending = await env.run(env.bc.transfer(intent, { idempotencyKey: 'corrupt' }));
    const stored = await env.stores.operations.get('default', pending.operationId);
    await env.stores.operations.update(
      'default',
      pending.operationId,
      {
        partialSignatures: [{ requestId: 'r0', bytes: new Uint8Array(64), recovery: 0 }],
      },
      stored?.version ?? 0,
    );
    const signature = await externalSignature(env, inner, 'corrupt', intent);
    const done = await env.run(env.bc.submitSignatures(pending.operationId, [signature]));
    expect(done.state).toBe('submitted');
  });

  it('re-signs over a corrupt persisted partial instead of failing the operation', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const intent = { to: env.stranger(), amount: 3n };
    const prepared = await env.run(
      env.bc.prepareTransfer(intent, { idempotencyKey: 'p' }),
    );
    const stored = await env.stores.operations.get('default', prepared.operation.id);
    await env.stores.operations.update(
      'default',
      prepared.operation.id,
      {
        partialSignatures: [{ requestId: 'r0', bytes: new Uint8Array(64), recovery: 0 }],
      },
      stored?.version ?? 0,
    );
    const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'p' }));
    expect(sub.state).toBe('submitted');
    expect(calls()).toBe(1);
  });

  it('refuses to rebroadcast an operation that has no signed attempt', async () => {
    const env = await createFakeEnv();
    const prepared = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    await expect(
      env.run(env.bc.rebroadcast(prepared.operation.id)),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('transfer: broadcast answers never override stronger evidence (R24)', () => {
  type Env = Awaited<ReturnType<typeof createFakeEnv>>;

  /** A submitted transfer that is mined; the engine holds an `included` observation of it. */
  async function minedTransfer(env: Env) {
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'm' }),
    );
    env.chain.mine();
    const op = await env.stores.operations.get('default', sub.operationId);
    const attemptId = op?.activeAttemptId ?? '';
    const current = await env.stores.operations.getObservation(attemptId);
    if (!current) throw new Error('unreachable');
    const { version, ...rest } = current;
    await env.stores.operations.putObservation(
      { ...rest, state: 'included', confirmations: 1 },
      version,
    );
    // This reader lags one block, so it no longer sees the mined transaction at all.
    env.chain.configureEndpoint('main', { lag: 1 });
    return { operationId: sub.operationId, attemptId };
  }

  async function expectUntouched(env: Env, operationId: string, attemptId: string) {
    const op = await env.stores.operations.get('default', operationId);
    expect(op).toMatchObject({
      state: 'submitted',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    expect(op?.error).toBeUndefined();
    expect(await env.stores.operations.getObservation(attemptId)).toMatchObject({
      state: 'included',
    });
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, next.operation.id)).toBe(1n);
  }

  it('does not stall a mined transfer when a lagging reader cannot see it after a refusal', async () => {
    const env = await createFakeEnv();
    const stalled: string[] = [];
    env.aio.on('operation.stalled', (e) => stalled.push(e.code));
    const { operationId, attemptId } = await minedTransfer(env);
    const resumed = await env.run(env.bc.rebroadcast(operationId));
    expect(resumed.state).toBe('submitted');
    expect(stalled).toEqual([]);
    await expectUntouched(env, operationId, attemptId);
  });

  it('does not fail a mined transfer when a lagging reader cannot see it after a rejection', async () => {
    const env = await createFakeEnv();
    const { operationId, attemptId } = await minedTransfer(env);
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    const resumed = await env.run(env.bc.rebroadcast(operationId));
    expect(resumed.state).toBe('submitted');
    await expectUntouched(env, operationId, attemptId);
  });

  it('looks up its own transaction before treating a rejection as proof', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'mp' }),
    );
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    const resumed = await env.run(env.bc.rebroadcast(sub.operationId));
    expect(resumed.state).toBe('submitted');
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('submitted');
    expect(
      (await env.stores.operations.getObservation(op?.activeAttemptId ?? ''))?.state,
    ).toBe('pending');
    env.chain.mine();
    expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
  });

  it('schedules a check and names the operation when its own-ref lookup fails', async () => {
    const env = await createFakeEnv();
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    const off = env.aio.on('rpc.error', (e) => {
      if (e.method !== 'fake_sendRawTransaction') return;
      off();
      env.chain.configureEndpoint('main', { down: true });
    });
    const error = await env
      .run(env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'ol' }))
      .catch((e: unknown) => e);
    // R27: after a broadcast, an unrecorded outcome is ambiguous STATE_UNRECORDED.
    expect(error).toMatchObject({
      code: 'STATE_UNRECORDED',
      ambiguous: true,
      context: expect.objectContaining({ operationId: expect.any(String) }),
      details: { causeCode: 'PROVIDER_UNAVAILABLE' },
    });
    const op = await env.stores.operations.getByKey('default', 'ol');
    expect(op).toMatchObject({
      state: 'signed',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    expect(op?.nextCheckAt).toBeDefined();
  });
});

describe('transfer: one signing per operation on expiry chains (R24)', () => {
  it('signs once when a same-key repeat arrives while the first call is signing', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'slow' }).signer;
    const clock: { current?: FakeClock } = {};
    let signCalls = 0;
    let hookRuns = 0;
    const slow = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: async (requests, signingCtx) => {
        signCalls += 1;
        await clock.current?.sleep(5_000);
        return inner.sign(requests, signingCtx);
      },
    });
    const env = await createFakeEnv({
      ordering: 'expiry',
      signer: slow,
      hooks: {
        beforeSign: () => {
          hookRuns += 1;
        },
      },
    });
    clock.current = env.clock;
    const intent = { to: env.stranger(), amount: 3n };
    const first = env.bc.transfer(intent, { idempotencyKey: 'dup' });
    first.catch(() => undefined);
    for (let i = 0; i < 100 && signCalls === 0; i++) await env.clock.advance(100);
    expect(signCalls).toBe(1);
    const second = env.bc.transfer(intent, { idempotencyKey: 'dup' });
    const [a, b] = await env.run(Promise.all([first, second]));
    expect(signCalls).toBe(1);
    expect(hookRuns).toBe(1);
    expect(b.operationId).toBe(a.operationId);
    expect(b.state).toBe('submitted');
    const op = await env.stores.operations.get('default', a.operationId);
    expect(op?.attempts).toHaveLength(1);
  });

  it('continues with the winning attempt when its own attempt lost the append race', async () => {
    const inner = new MemoryOperationStore(new FakeClock());
    let raced = false;
    const operations = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'appendAttempt') {
          return async (...args: Parameters<OperationStore['appendAttempt']>) => {
            if (!raced) {
              // Another process appends its own Attempt first (same bytes, another id).
              raced = true;
              const [namespace, id, attempt, patch, version, fence] = args;
              await target.appendAttempt(
                namespace,
                id,
                { ...attempt, id: 'att_winner' },
                patch,
                version,
                fence,
              );
            }
            return target.appendAttempt(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const env = await createFakeEnv({ ordering: 'expiry', stores: { operations } });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 3n }, { idempotencyKey: 'race' }),
    );
    expect(sub.state).toBe('submitted');
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.attempts.map((a) => a.id)).toEqual(['att_winner']);
    expect(op?.activeAttemptId).toBe('att_winner');
    env.chain.mine();
    expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
  });
});

describe('transfer: cold wallets', () => {
  it('lands a transfer prepared by a watch-only wallet and signed offline', async () => {
    const env = await createFakeEnv();
    const publicKey = await env.signer.getPublicKey('secp256k1-ecdsa');
    const cold = env.aio
      .scope({ wallets: { cold: { publicKey: toHex(publicKey) } } })
      .blockchain({ chain: 'fakechain', wallet: 'cold' });
    const recipient = env.stranger();
    const prepared = await env.run(
      cold.prepareTransfer({ to: recipient, amount: 7n }, { idempotencyKey: 'cold-1' }),
    );
    // Offline: the key holder signs the exported requests (here the same local key).
    const signed = await env.signer.sign(prepared.unsigned?.signingRequests ?? [], ctx);
    if (signed.status !== 'signed') throw new Error('unreachable');
    const sub = await env.run(
      cold.submitSignatures(prepared.operation.id, signed.signatures),
    );
    expect(sub.state).toBe('submitted');
    expect(sub.operationId).toBe(prepared.operation.id);
    env.chain.mine();
    expect(env.chain.receipt(sub.attempt?.id ?? '')?.success).toBe(true);
    expect(env.chain.balance(recipient)).toBe(7n);

    // A second submission after success is refused and changes nothing.
    await expect(
      env.run(cold.submitSignatures(prepared.operation.id, signed.signatures)),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const op = await env.stores.operations.get('default', prepared.operation.id);
    expect(op?.attempts).toHaveLength(1);
    expect(env.chain.sendCount(sub.attempt?.id ?? '')).toBe(1);
  });
});
