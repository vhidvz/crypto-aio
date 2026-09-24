import { secp256k1 } from '@noble/curves/secp256k1';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import { toHex } from '../../../src/core/util/bytes';
import { fakeAddress, signFake } from '../../../src/testing/fake-chain';
import { createFakeEnv, type FakeEnvOptions } from '../../../src/testing/env';
import { ctx } from '../signing/fixtures';
import { countingSigner } from './support';

const nonceOf = async (env: Awaited<ReturnType<typeof createFakeEnv>>, id: string) => {
  const reservation = (await env.stores.operations.get('default', id))?.reservation;
  return reservation?.kind === 'nonce' ? reservation.nonce : undefined;
};

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
    expect(error).toMatchObject({
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
      retryable: true,
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
  // Carry-forward (signer deadline): an answer after the lease expired could never be
  // persisted (a lease cannot be renewed after expiry), so the wait is bounded by the lease.
  it('stops waiting for a signer that never answers once the lease would expire', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hung' }).signer;
    const hung = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: () => new Promise(() => undefined),
    });
    const env = await createFakeEnv({ signer: hung });
    const intent = { to: env.stranger(), amount: 3n };
    const started = env.clock.now();
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'hung' }), 1_000),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(env.clock.now() - started).toBeLessThanOrEqual(31_000);
    const op = await env.stores.operations.getByKey('default', 'hung');
    expect(op).toMatchObject({
      state: 'prepared',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    expect(op?.attempts).toHaveLength(0);
    // The lease was given back: another transfer allocates the next nonce straight away.
    const other = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect(await nonceOf(env, other.operation.id)).toBe(1n);
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
