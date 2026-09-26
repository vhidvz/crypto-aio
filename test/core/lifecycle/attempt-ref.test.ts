// A15 (found by Plans 4 and 5): the engine never records one Attempt ref on two Operations
// of a namespace. Without it, two identical transfers on a chain without nonces sign into
// the same bytes, the second broadcast answers "already known", and both Operations end
// `final`: one payment is silently lost.
import { internalsOf } from '../../../src/core/blockchain/internal';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import type { SignedTx, UnsignedTx } from '../../../src/core/model/transaction';
import type { SignatureBundle } from '../../../src/core/signing/types';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';

const NS = 'default';
const record = (env: FakeEnv, id: string) => env.stores.operations.get(NS, id);

/** A driver that signs every later Attempt into the transaction id `id`. */
async function signInto(env: FakeEnv, id: string): Promise<void> {
  const { driver } = await env.run(internalsOf(env.bc).pooled());
  const assemble = driver.builder.assemble.bind(driver.builder);
  Object.assign(driver.builder, {
    assemble: async (
      unsigned: UnsignedTx,
      signatures: readonly SignatureBundle[],
    ): Promise<SignedTx> => {
      const signed = await assemble(unsigned, signatures);
      return { ...signed, ref: { ...signed.ref, id } };
    },
  });
}

describe('Attempt ref uniqueness (A15)', () => {
  it("refuses a second Operation that would hold another Operation's Attempt ref", async () => {
    // The fake expiry chain signs identical transfers into identical bytes, as Tron and
    // Solana do without their drivers' build variants.
    const env = await createFakeEnv({ ordering: 'expiry' });
    const to = env.stranger();
    const first = await env.run(
      env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k1' }),
    );
    await expect(
      env.run(env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k2' })),
    ).rejects.toMatchObject({
      name: 'ChainError',
      code: 'NONCE_CONFLICT',
      retryable: false,
      details: { heldBy: first.operationId },
    });
    // Failed before any signed bytes were recorded, so nothing was sent twice.
    expect(await env.stores.operations.getByKey(NS, 'k2')).toMatchObject({
      state: 'failed',
      attempts: [],
      error: { code: 'NONCE_CONFLICT' },
    });
    expect((await record(env, first.operationId))?.attempts).toHaveLength(1);
    // A same-key repeat returns the stored failure; a different transfer goes through.
    await expect(
      env.run(env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k2' })),
    ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    const third = await env.run(
      env.bc.transfer({ to, amount: 6n }, { idempotencyKey: 'k3' }),
    );
    expect(third.state).toBe('submitted');
  });

  it('refuses when the holder has already ended, too (D4)', async () => {
    const env = await createFakeEnv({ ordering: 'expiry' });
    const to = env.stranger();
    const first = await env.run(
      env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k1' }),
    );
    const stored = await record(env, first.operationId);
    // A final holder: those bytes are on chain, so a second Operation would inherit them.
    await env.stores.operations.update(
      NS,
      first.operationId,
      { state: 'final', outcome: 'executed' },
      stored?.version ?? 0,
    );
    await expect(
      env.run(env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k2' })),
    ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
  });

  it('drops a replacement whose ref another Operation holds, keeping the active Attempt', async () => {
    const env = await createFakeEnv();
    const a = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 5n }, { idempotencyKey: 'a' }),
    );
    const b = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 6n }, { idempotencyKey: 'b' }),
    );
    // A driver that signs b's replacement into a's transaction id.
    await signInto(env, (await record(env, a.operationId))?.attempts[0]?.ref.id ?? '');
    const before = await record(env, b.operationId);
    await expect(
      env.run(env.bc.replace(b.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    const after = await record(env, b.operationId);
    expect(after?.attempts).toHaveLength(1);
    expect(after).toMatchObject({
      state: before?.state,
      activeAttemptId: before?.activeAttemptId,
    });
  });

  it('lets exactly one of two processes record a shared ref (D5: the ref lease)', async () => {
    const env = await createFakeEnv({ ordering: 'expiry' });
    const other = await env.restart();
    const to = env.stranger();
    const results = await env.run(
      Promise.allSettled([
        env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'p1' }),
        other.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'p2' }),
      ]),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({
      code: 'NONCE_CONFLICT',
    });
    const holders = await env.stores.operations.list({ namespace: NS });
    expect(holders.filter((op) => op.attempts.length > 0)).toHaveLength(1);
  });

  it('keeps the nonce of a refused original on a nonce chain (M6)', async () => {
    const env = await createFakeEnv();
    const a = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 5n }, { idempotencyKey: 'a' }),
    );
    await signInto(env, (await record(env, a.operationId))?.attempts[0]?.ref.id ?? '');
    await expect(
      env.run(
        env.bc.transfer({ to: env.stranger(), amount: 6n }, { idempotencyKey: 'b' }),
      ),
    ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    const b = await env.stores.operations.getByKey(NS, 'b');
    expect(b?.state).toBe('failed');
    const nonce = b?.reservation?.kind === 'nonce' ? b.reservation.nonce : undefined;
    expect(nonce).toBeDefined();
    const from = (await env.run(env.bc.walletAddress())).canonical;
    const sequence = await env.stores.sequences.get(
      sequenceKey(NS, 'fakechain', 'local', from),
    );
    expect(sequence?.released ?? []).not.toContain(nonce);
  });

  it('reports a ref lease held elsewhere as SEQUENCE_BUSY with its own text (M7)', async () => {
    const env = await createFakeEnv({ ordering: 'expiry' });
    const to = env.stranger();
    await signInto(env, 'busy-ref');
    const held = await env.stores.locks.acquire(`ref:${NS}:busy-ref`, 'another', 600_000);
    await expect(
      env.run(env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_BUSY',
      retryable: true,
      message: 'another operation is recording the same transaction; retry',
    });
    expect((await env.stores.operations.getByKey(NS, 'k'))?.attempts).toEqual([]);
    if (held) await env.stores.locks.release(held);
    const repeat = await env.run(
      env.bc.transfer({ to, amount: 5n }, { idempotencyKey: 'k' }),
    );
    expect(repeat.state).toBe('submitted');
  });
});
