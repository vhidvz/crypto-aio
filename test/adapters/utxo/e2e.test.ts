import { walletAddress } from '../../../src/adapters/utxo/address';
import { networkOf, txidOfHex } from '../../../src/adapters/utxo/codec';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { AttemptRecord, OperationPatch } from '../../../src/core/store/types';
import { toHex } from '../../../src/core/util/bytes';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import type { FakeRequest } from '../../../src/testing/fake-fetch';
import { countingSigner, createUtxoEnv, mineWhile, type UtxoEnv } from './support/env';
import { malleate, nativeSigner, nativeTaprootSigner, signedSpend } from './support/tx';
import {
  OTHER_KEY,
  OTHER_PUBKEY,
  REGTEST,
  TEST_KEY,
  TEST_PUBKEY,
} from './support/vectors';

const NETWORK = networkOf(REGTEST);

// Determinism (R46; the board's harness rule of a fixed `random`): the container builds its
// own transports, so their backoff jitter is pinned here, through Math.random.
beforeEach(() => {
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function finalOf(env: UtxoEnv, operationId: string) {
  env.node.mine(6);
  return env.run(env.bc.waitForConfirmation(operationId, { finality: 'final' }));
}

const outpointsOf = (env: UtxoEnv, txid: string): string[] =>
  (env.node.transaction(txid)?.ins ?? []).map(
    (i) => `${toHex(Uint8Array.from(i.hash).reverse())}:${i.index}`,
  );

describe('UTXO transfers end to end (scripted Esplora node)', () => {
  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const)(
    '%s: sends, pays change back, and becomes final after 6 confirmations',
    async (addressType) => {
      const env = await createUtxoEnv({ addressType });
      expect(env.address).toBe(walletAddress(TEST_PUBKEY, addressType, REGTEST).address);
      const intent = { to: env.stranger(), amount: 150_000n };
      const to = intent.to;
      const prepared = await env.run(
        env.bc.prepareTransfer(intent, { idempotencyKey: 'k' }),
      );
      expect(prepared.unsigned?.payload.encoding).toBe('base64');
      // The next transfer with the key signs the stored PSBT (spec §8.2).
      const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'k' }));
      expect(sub.state).toBe('submitted');
      // The txid is known before signing only when every input is witness-type (spec §15).
      expect(prepared.unsigned?.expectedRef?.id).toBe(
        addressType === 'p2pkh' ? undefined : sub.attempt?.id,
      );
      const done = await finalOf(env, sub.operationId);
      expect(done.status.state).toBe('final');
      expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(150_000n);
      const record = await env.stores.operations.get('default', sub.operationId);
      const paid = record?.attempts[0]?.fee.charges[0]?.amount ?? 0n;
      expect(paid).toBeGreaterThan(0n);
      expect(record?.attempts[0]?.fee.bound).toBe('exact');
      expect((await env.run(env.bc.getBalance(env.address))).amount.base).toBe(
        300_000n - 150_000n - paid,
      );
    },
  );

  it('sends a batch in one transaction', async () => {
    const env = await createUtxoEnv();
    const [a, b] = [env.stranger(), env.stranger()];
    const sub = await env.run(
      env.bc.transfer({
        outputs: [
          { to: a, amount: 10_000n },
          { to: b, amount: 20_000n },
        ],
      }),
    );
    await finalOf(env, sub.operationId);
    expect((await env.run(env.bc.getBalance(a))).amount.base).toBe(10_000n);
    expect((await env.run(env.bc.getBalance(b))).amount.base).toBe(20_000n);
    expect((await env.run(env.bc.limits())).maxOutputs).toBe(1_000);
  });
});

describe('cold signing with a PSBT (A6)', () => {
  async function coldEnv(addressType: 'p2wpkh' | 'p2tr' = 'p2wpkh') {
    const env = await createUtxoEnv({ addressType });
    const cold = env.aio
      .scope({
        wallets: {
          cold: { publicKey: toHex(TEST_PUBKEY), utxo: { addressType } },
        },
      })
      .blockchain({ chain: 'bitcoin', wallet: 'cold' });
    const prepared = await env.run(
      cold.prepareTransfer(
        { to: env.stranger(), amount: 50_000n },
        { idempotencyKey: 'cold' },
      ),
    );
    return { env, cold, prepared };
  }

  it.each(['p2wpkh', 'p2tr'] as const)(
    '%s: lands a PSBT signed by an external wallet',
    async (addressType) => {
      const { env, cold, prepared } = await coldEnv(addressType);
      const psbt = bitcoin.Psbt.fromBase64(prepared.unsigned?.payload.data ?? '', {
        network: NETWORK,
      });
      const tweak = walletAddress(TEST_PUBKEY, 'p2tr', REGTEST).tweak as Uint8Array;
      psbt.signAllInputs(
        addressType === 'p2tr'
          ? nativeTaprootSigner(TEST_KEY, tweak)
          : nativeSigner(TEST_KEY),
      );
      const sub = await env.run(
        cold.submitSignatures(prepared.operation.id, {
          encoding: 'base64',
          data: psbt.toBase64(),
        }),
      );
      expect(sub.state).toBe('submitted');
      expect(sub.attempt?.id).toBe(prepared.unsigned?.expectedRef?.id);
      expect(env.node.inMempool(sub.attempt?.id ?? '')).toBe(true);
    },
  );

  it('refuses a PSBT whose outputs were changed, and writes nothing (Review Focus 1)', async () => {
    const { env, cold, prepared } = await coldEnv();
    const psbt = bitcoin.Psbt.fromBase64(prepared.unsigned?.payload.data ?? '', {
      network: NETWORK,
    });
    const tampered = bitcoin.Psbt.fromBase64(psbt.toBase64(), { network: NETWORK });
    tampered.addOutput({
      script: bitcoin.address.toOutputScript(env.stranger(), NETWORK),
      value: 1_000n,
    });
    tampered.signAllInputs(nativeSigner(TEST_KEY));
    await expect(
      env.run(
        cold.submitSignatures(prepared.operation.id, {
          encoding: 'base64',
          data: tampered.toBase64(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    const op = await env.stores.operations.get('default', prepared.operation.id);
    expect(op?.attempts).toHaveLength(0);
    expect(env.node.broadcasts).toHaveLength(0);
  });
});

describe('the inputs ordering (handoff §3)', () => {
  it.each([
    ['its index is current', 0],
    ['its index trails the mempool', 60_000],
  ])(
    'never lets two concurrent transfers spend the same output while %s (Review Focus 3)',
    async (_case, delay) => {
      const env = await createUtxoEnv({ fund: [100_000n, 100_000n, 100_000n] });
      // Trailing, the index still lists an output a sent transfer spends: only the inputs
      // reservation keeps the next transfer off it.
      env.node.setMempoolDelay('a', delay);
      const results = await env.run(
        Promise.allSettled(
          [1, 2, 3, 4].map((n) =>
            env.bc.transfer(
              { to: env.stranger(), amount: 60_000n },
              { idempotencyKey: `c${n}` },
            ),
          ),
        ),
      );
      const sent = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      expect(sent).toHaveLength(3);
      expect(failed).toEqual([expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' })]);
      const spent = sent.flatMap((s) => outpointsOf(env, s.attempt?.id ?? ''));
      expect(new Set(spent).size).toBe(spent.length);
      expect(sent.every((s) => env.node.inMempool(s.attempt?.id ?? ''))).toBe(true);
    },
  );

  it('keeps the inputs of a prepared Operation from every other transfer', async () => {
    const env = await createUtxoEnv({ fund: [100_000n] });
    await env.run(env.bc.prepareTransfer({ to: env.stranger(), amount: 50_000n }));
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('spends only confirmed outputs by default (minInputConfirmations 1)', async () => {
    const env = await createUtxoEnv({ fund: [] });
    env.node.fund(env.address, 100_000n, { mempool: true });
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const eager = await createUtxoEnv({
      fund: [],
      options: { minInputConfirmations: 0 },
    });
    eager.node.fund(eager.address, 100_000n, { mempool: true });
    const sub = await eager.run(
      eager.bc.transfer({ to: eager.stranger(), amount: 10_000n }),
    );
    expect(sub.state).toBe('submitted');
  });
});

describe('replace and cancel (BIP125 RBF)', () => {
  it('replaces a transfer with a higher fee over the same inputs, and the replacement wins', async () => {
    const env = await createUtxoEnv();
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 50_000n, fee: 'slow' }),
    );
    const original = sub.attempt?.id ?? '';
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { satPerVByte: '2' } })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const replaced = await env.run(env.bc.replace(sub.operationId, { fee: 'fast' }));
    const replacement = replaced.attempt?.id ?? '';
    expect(replacement).not.toBe(original);
    expect(env.node.inMempool(original)).toBe(false);
    expect(env.node.inMempool(replacement)).toBe(true);
    expect(outpointsOf(env, replacement)).toEqual(
      expect.arrayContaining(outpointsOf(env, original)),
    );
    const done = await finalOf(env, sub.operationId);
    expect(done.status.state).toBe('final');
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('cancels a transfer by spending its inputs back to the wallet', async () => {
    const env = await createUtxoEnv();
    const to = env.stranger();
    const sub = await env.run(env.bc.transfer({ to, amount: 50_000n, fee: 'slow' }));
    const cancelled = await env.run(env.bc.cancel(sub.operationId));
    const cancel = env.node.transaction(cancelled.attempt?.id ?? '');
    expect(cancel?.outs).toHaveLength(1);
    await finalOf(env, sub.operationId);
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(0n);
  });

  it('refuses a replacement or cancel once the original is mined, and the payment stands (F3-R22)', async () => {
    const env = await createUtxoEnv();
    const to = env.stranger();
    const sub = await env.run(env.bc.transfer({ to, amount: 50_000n, fee: 'slow' }));
    env.node.mine(1);
    // Before the monitor has seen the block, the node refuses them: their inputs are spent.
    for (const attempt of [
      () => env.bc.replace(sub.operationId, { fee: 'fast' }),
      () => env.bc.cancel(sub.operationId),
    ]) {
      await expect(env.run(attempt())).rejects.toMatchObject({
        code: 'TX_REFUSED',
        message: expect.stringContaining('inputs missing or already spent'),
      });
      expect(await env.run(env.bc.getOperation(sub.operationId))).toMatchObject({
        state: 'submitted',
        activeAttempt: { id: sub.attempt?.id },
      });
    }
    // Once it has, the Operation is `included`, and neither can be made.
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    expect(await env.run(env.bc.getOperation(sub.operationId))).toMatchObject({
      state: 'included',
    });
    for (const attempt of [
      () => env.bc.replace(sub.operationId, { fee: 'fast' }),
      () => env.bc.cancel(sub.operationId),
    ]) {
      await expect(env.run(attempt())).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
    }
    const done = await finalOf(env, sub.operationId);
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(50_000n);
  });

  it('fails a transfer whose input a third party spent at final depth (TX_REPLACED)', async () => {
    const env = await createUtxoEnv({ fund: [100_000n] });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 50_000n }));
    // A conflicting spend of the same output, mined by someone else (a miner's own double spend).
    const signed = env.node.transaction(sub.attempt?.id ?? '');
    const psbt = new bitcoin.Psbt({ network: NETWORK });
    const input = signed?.ins[0];
    const funding = env.node.transaction(toHex(Uint8Array.from(input!.hash).reverse()));
    psbt.addInput({
      hash: Uint8Array.from(input!.hash),
      index: input!.index,
      witnessUtxo: { script: funding!.outs[input!.index]!.script, value: 100_000n },
    });
    psbt.addOutput({
      script: bitcoin.address.toOutputScript(env.stranger(), NETWORK),
      value: 90_000n,
    });
    psbt.signAllInputs(nativeSigner(TEST_KEY)).finalizeAllInputs();
    env.node.mine(1, { extra: [psbt.extractTransaction().toHex()] });
    expect(env.node.inMempool(sub.attempt?.id ?? '')).toBe(false);
    env.node.mine(6);
    await expect(
      env.run(env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({ code: 'TX_REPLACED' });
  });
});

describe('crash safety on the inputs ordering (handoff R20: killPrevious)', () => {
  async function crashEnv() {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createUtxoEnv({ signer, stores: { operations: faulty } });
    return { env, faulty, calls, intent: { to: env.stranger(), amount: 50_000n } };
  }
  const patchState = (state: string) => (args: readonly unknown[]) =>
    (args[2] as OperationPatch | undefined)?.state === state;

  it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const stored = await env.stores.operations.getByKey('default', 'k');
    const ref = stored?.attempts[0]?.ref.id ?? '';
    expect(env.node.sendCount(ref)).toBe(0);
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(sub).toMatchObject({ state: 'submitted', attempt: { id: ref } });
    expect(env.node.inMempool(ref)).toBe(true);
    expect(calls()).toBe(1);
    expect(env.clock.pending).toBe(0);
    // The kill is wired: a call on the old handle never settles.
    let settled = false;
    void env.bc.getOperation(sub.operationId).finally(() => {
      settled = true;
    });
    await env.clock.advance(5_000);
    expect(settled).toBe(false);
  });

  it('treats its own already-mined transaction as sent after a crash', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'update', timing: 'before', when: patchState('submitted') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({
      code: 'STATE_UNRECORDED',
      ambiguous: true,
    });
    const ref =
      (await env.stores.operations.getByKey('default', 'k'))?.attempts[0]?.ref.id ?? '';
    env.node.mine(1);
    const restarted = await env.restart({ killPrevious: true });
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(['submitted', 'included']).toContain(sub.state);
    expect(env.node.sendCount(ref)).toBe(2);
    expect(calls()).toBe(1);
  });

  it('keeps the inputs of a crashed prepared Operation reserved, then signs its stored PSBT', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'update', timing: 'after', when: patchState('prepared') });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    const reserved = (await env.stores.operations.getByKey('default', 'k'))?.reservation;
    expect(reserved?.kind).toBe('inputs');
    const other = await restarted.run(
      restarted.bc.transfer(
        { to: env.stranger(), amount: 20_000n },
        { idempotencyKey: 'other' },
      ),
    );
    const held = reserved?.kind === 'inputs' ? reserved.inputs : [];
    expect(outpointsOf(env, other.attempt?.id ?? '').some((o) => held.includes(o))).toBe(
      false,
    );
    const sub = await restarted.run(
      restarted.bc.transfer(intent, { idempotencyKey: 'k' }),
    );
    expect(outpointsOf(env, sub.attempt?.id ?? '').sort()).toEqual([...held].sort());
    expect(calls()).toBe(2);
  });

  it('recovery rebroadcasts a signed transfer and never signs', async () => {
    const { env, faulty, calls, intent } = await crashEnv();
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
    ).rejects.toBeInstanceOf(CrashError);
    const restarted = await env.restart({ killPrevious: true });
    const report = await restarted.run(restarted.aio.operations.recover());
    expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
    const ref =
      (await env.stores.operations.getByKey('default', 'k'))?.attempts[0]?.ref.id ?? '';
    expect(env.node.inMempool(ref)).toBe(true);
    expect(calls()).toBe(1);
  });
});

describe('crash during replace (M12)', () => {
  it('resends the stored replacement after a crash, never re-signs it, and keeps its inputs', async () => {
    const { signer, calls } = countingSigner();
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const env = await createUtxoEnv({
      signer,
      stores: { operations: faulty },
      fund: [60_000n, 30_000n],
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 50_000n, fee: 'slow' }),
    );
    // 100 sat/vB cannot come out of the change alone: the replacement adds the 30,000 output.
    faulty.crashOn({
      method: 'appendAttempt',
      timing: 'after',
      when: (args) => (args[2] as AttemptRecord).purpose === 'replacement',
    });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: { satPerVByte: 100n } })),
    ).rejects.toBeInstanceOf(CrashError);
    expect(calls()).toBe(2);
    const stored = await env.stores.operations.get('default', sub.operationId);
    const replacement = stored?.attempts[1];
    expect(
      replacement?.ordering.kind === 'inputs' && replacement.ordering.inputs,
    ).toHaveLength(2);
    expect(env.node.sendCount(replacement?.ref.id ?? '')).toBe(0);
    const restarted = await env.restart({ killPrevious: true });
    // Unsent, its added output is still listed unspent: the stored Attempt holds it.
    await expect(
      restarted.run(restarted.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const again = await restarted.run(
      restarted.bc.replace(sub.operationId, { fee: { satPerVByte: 100n } }),
    );
    expect(again.attempt?.id).toBe(replacement?.ref.id);
    expect(env.node.inMempool(replacement?.ref.id ?? '')).toBe(true);
    expect(calls()).toBe(2);
    await expect(
      restarted.run(restarted.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    restarted.node.mine(6);
    const done = await restarted.run(
      restarted.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
  });
});

describe('proofs that must decide nothing (C1) and a malleated p2pkh copy (C2)', () => {
  it('never proves our own final transfer replaced while a backend is behind (C1)', async () => {
    const env = await createUtxoEnv({ endpoints: ['a', 'b'] });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 50_000n }));
    const ours = sub.attempt?.id ?? '';
    env.node.mine(7);
    // Per pass: the monitor's observe hits a backend that never indexed our transaction
    // (a 404), so the core asks slotConsumed(finalized), which the quorum attests (our own
    // spend is final); then, before includedFinal reads the head, the load-balanced
    // backends fall 3 blocks behind. includedFinal must decide nothing, never "not included".
    let observed = false;
    let behind = false;
    const backend = (request: FakeRequest) => {
      const path = request.url.pathname;
      if (path.endsWith(`/tx/${ours}`)) {
        if (!observed) {
          observed = true;
          return { status: 404, text: 'Transaction not found' };
        }
        behind = true;
        return undefined;
      }
      if (behind && path.endsWith('/blocks/tip/height')) {
        return { text: String(env.node.height - 3) };
      }
      return undefined;
    };
    env.node.intercept('a', backend);
    env.node.intercept('b', backend);
    for (let pass = 0; pass < 5; pass++) {
      observed = false;
      behind = false;
      await env.clock.advance(1_000);
      await env
        .run(env.aio.monitor.runOnce({ workerId: `w${pass}` }))
        .catch(() => undefined);
      const op = await env.stores.operations.get('default', sub.operationId);
      const observation = await env.stores.operations.getObservation(
        op?.attempts[0]?.id ?? '',
      );
      // Each pass reached includedFinal: the 404, then the behind head, were both served.
      expect({ observed, behind }).toEqual({ observed: true, behind: true });
      expect(op?.state).not.toBe('failed');
      expect(observation?.state === 'replaced' && observation.evidence === 'proven').toBe(
        false,
      );
    }
    env.node.clearIntercept('a');
    env.node.clearIntercept('b');
    const done = await env.run(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('finalizes a p2pkh transfer that a miner mined as a malleated copy (C2)', async () => {
    const env = await createUtxoEnv({ addressType: 'p2pkh' });
    const to = env.stranger();
    const sub = await env.run(env.bc.transfer({ to, amount: 150_000n }));
    const ours = sub.attempt?.id ?? '';
    const copy = malleate(env.node.transaction(ours)!.toHex(), 'high-s');
    env.node.mine(1, { extra: [copy] });
    expect(env.node.inMempool(ours)).toBe(false);
    env.node.mine(6);
    const done = await env.run(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    const op = await env.stores.operations.get('default', sub.operationId);
    const observation = await env.stores.operations.getObservation(
      op?.attempts[0]?.id ?? '',
    );
    expect(observation).toMatchObject({
      state: 'final',
      evidence: 'proven',
      txHash: txidOfHex(copy),
    });
    expect(op?.error).toBeUndefined();
    // The Attempt keeps its original id; the chain has the copy under its own txid.
    expect(op?.attempts[0]?.ref.id).toBe(ours);
    expect(await env.run(env.bc.getTransaction(ours))).toBeNull();
    const mined = await env.run(env.bc.getTransaction(txidOfHex(copy)));
    expect(mined?.id).toBe(txidOfHex(copy));
    expect(mined?.transfers.find((t) => t.to.canonical === to)?.amount?.base).toBe(
      150_000n,
    );
    expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(150_000n);
  });
});

describe('mempool eviction, reorgs and lagging endpoints', () => {
  it('stalls an evicted low-fee transfer until it is replaced, keeping its inputs (Review Focus 5)', async () => {
    const env = await createUtxoEnv({
      fund: [100_000n],
      node: { errorFormat: 'mempool' },
    });
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: 50_000n, fee: 'slow' }),
    );
    const ref = sub.attempt?.id ?? '';
    env.node.setMempoolMinFee(5_000n); // a full mempool now wants 5 sat/vB
    env.node.evict(ref);
    await env.clock.advance(11_000); // past droppedGracePeriodMs
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    // Absence is never proof (spec §6.7): pending or dropped, never terminal.
    const status = await env.run(env.bc.getTransactionStatus(ref));
    expect(['pending', 'dropped']).toContain(status.state);
    // The explicit resend meets bitcoind's "mempool min fee not met": refused, never terminal.
    await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
      code: 'FEE_TOO_LOW',
    });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('stalled');
    // The stalled Operation still holds its input: nothing else can take it.
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const replaced = await env.run(env.bc.replace(sub.operationId, { fee: 'fast' }));
    expect(env.node.inMempool(replaced.attempt?.id ?? '')).toBe(true);
    const done = await finalOf(env, sub.operationId);
    expect(done.operation?.state).toBe('final');
  });

  it('survives a reorg that drops the transaction and still finalizes it', async () => {
    const env = await createUtxoEnv();
    const reorgs: unknown[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 50_000n }));
    const ref = sub.attempt?.id ?? '';
    env.node.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    env.node.reorg(1, { drop: [ref] });
    env.node.mine();
    expect(env.node.inMempool(ref)).toBe(false);
    const final = await mineWhile(
      env,
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation?.state).toBe('final');
    expect(reorgs.length).toBeGreaterThanOrEqual(1);
    expect(env.node.sendCount(ref)).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['b', 'a'],
    ['a', 'b'],
  ] as const)(
    'decides nothing while an endpoint lags or over-reports its head (Review Focus 2: %s over-reports, %s lags)',
    async (over, lagging) => {
      const env = await createUtxoEnv({ endpoints: ['a', 'b'] });
      const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 50_000n }));
      env.node.mine(5); // 5 confirmations: one short of final
      // `over` claims a head 2 blocks higher (within maxLagBlocks), and `lagging` lags 1 block.
      // The monitor reads one endpoint's head (a, the first): when a over-reports, the block
      // looks final to it, and only the proof quorum's disagreement keeps it from `final`.
      env.node.intercept(over, (request) =>
        request.url.pathname.endsWith('/blocks/tip/height')
          ? { text: String(env.node.height + 2) }
          : undefined,
      );
      env.node.setLag(lagging, 1);
      for (let i = 0; i < 5; i++) {
        await env.clock.advance(1_000);
        await env.run(env.aio.monitor.runOnce({ workerId: `w${i}` }));
      }
      const op = await env.run(env.bc.getOperation(sub.operationId));
      expect(op?.state).not.toBe('final');
      expect(op?.attempts[0]?.status).toMatchObject({
        state: 'included',
        evidence: 'observed',
      });
      env.node.clearIntercept(over);
      env.node.setLag(lagging, 0);
      env.node.mine(1);
      const done = await env.run(
        env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
      );
      expect(done.operation?.state).toBe('final');
    },
  );
});

describe('observation', () => {
  it('scans a deposit, lists it in the history and reads the transaction', async () => {
    const env = await createUtxoEnv();
    const to = env.stranger();
    const sub = await env.run(env.bc.transfer({ to, amount: 42_000n }));
    env.node.mine(6);
    const iterator = env.bc
      .scanner({
        cursorKey: 'deposits',
        from: BigInt(env.node.height - 5),
        mode: 'head',
        filter: { addresses: [to] },
      })
      [Symbol.asyncIterator]();
    const event = await env.run(iterator.next(), 500);
    expect(event.value).toMatchObject({ type: 'block' });
    const txs = event.value.type === 'block' ? event.value.transactions : [];
    expect(txs.map((t: { id: string }) => t.id)).toEqual([sub.attempt?.id]);
    const history = await env.run(env.bc.history(to, { limit: 10 }));
    expect(history.items.map((t) => t.id)).toEqual([sub.attempt?.id]);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers.find((t) => t.to.canonical === to)?.amount?.base).toBe(42_000n);
    expect(tx?.decoding).toBe('complete');
  });
});

describe('the monitor, pass by pass (Task 9 carries)', () => {
  /** One monitor pass; the Operation's state and error, and its first Attempt's observation. */
  async function pass(env: UtxoEnv, operationId: string, n: number) {
    await env.clock.advance(1_000);
    expect(await env.run(env.aio.monitor.runOnce({ workerId: `w${n}` }))).toBe(1);
    const op = await env.stores.operations.get('default', operationId);
    const observation = await env.stores.operations.getObservation(
      op?.attempts[0]?.id ?? '',
    );
    return {
      state: op?.state,
      error: op?.error?.code,
      observation: [observation?.state, observation?.evidence],
    };
  }

  it('keeps a transient own spend observed only, never terminal, and finalizes the transfer (F3-R9)', async () => {
    const env = await createUtxoEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 50_000n }));
    const ours = sub.attempt?.id ?? '';
    // A stale index: a pass's first outspend read (the monitor's observe) says our input is
    // unspent, or its first /tx read is a 404; every later read names our own spend. The
    // core's slotConsumed('latest') then counts our own spend: an observed `replaced` at
    // most, never a proven one, and the Operation is never terminal.
    let stale = false;
    let missing = false;
    env.node.intercept('a', (request) => {
      const path = request.url.pathname;
      if (stale && path.includes('/outspend/')) {
        stale = false;
        return { json: { spent: false } };
      }
      if (missing && path.endsWith(`/tx/${ours}`)) {
        missing = false;
        return { status: 404, text: 'Transaction not found' };
      }
      return undefined;
    });
    const lying = async (n: number, lie: { stale?: boolean; missing?: boolean }) => {
      stale = lie.stale ?? false;
      missing = lie.missing ?? false;
      const seen = await pass(env, sub.operationId, n);
      expect({ stale, missing }).toEqual({ stale: false, missing: false }); // each lie was read
      return seen;
    };
    // In the mempool: the transient own spend.
    for (let n = 0; n < 3; n++) {
      expect(await lying(n, { stale: true })).toEqual({
        state: 'submitted',
        error: undefined,
        observation: ['replaced', 'observed'],
      });
      expect(env.node.inMempool(ours)).toBe(true);
      expect(env.node.sendCount(ours)).toBe(1);
    }
    expect(await pass(env, sub.operationId, 3)).toEqual({
      state: 'submitted',
      error: undefined,
      observation: ['mempool', 'observed'],
    });
    // In a block, then at final depth: a backend that lost it decides nothing.
    env.node.mine(1);
    expect(await pass(env, sub.operationId, 4)).toEqual({
      state: 'included',
      error: undefined,
      observation: ['included', 'observed'],
    });
    for (const [n, blocks] of [
      [5, 0],
      [6, 5],
      [7, 0],
    ] as const) {
      if (blocks > 0) env.node.mine(blocks);
      expect(await lying(n, { missing: true })).toEqual({
        state: 'included',
        error: undefined,
        observation: ['included', 'observed'],
      });
    }
    env.node.clearIntercept('a');
    const done = await env.run(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.sendCount(ours)).toBe(1);
  });

  it.each([
    ['replace', 'executed'],
    ['cancel', 'cancelled'],
  ] as const)(
    'links the original to our own winning %s: replaced by ours, never TX_REPLACED',
    async (how, outcome) => {
      const env = await createUtxoEnv();
      const sub = await env.run(
        env.bc.transfer({ to: env.stranger(), amount: 50_000n, fee: 'slow' }),
      );
      const original = sub.attempt?.id ?? '';
      const winner =
        (
          await env.run(
            how === 'replace'
              ? env.bc.replace(sub.operationId, { fee: 'fast' })
              : env.bc.cancel(sub.operationId),
          )
        ).attempt?.id ?? '';
      const statuses = async () =>
        (await env.run(env.bc.getOperation(sub.operationId)))?.attempts.map((a) => [
          a.ref.id,
          a.status?.state,
          a.status?.evidence,
          a.status?.replacedBy,
        ]);
      // Mined, not final: our own spend of the original's input is observed only.
      env.node.mine(1);
      expect(await pass(env, sub.operationId, 0)).toEqual({
        state: 'included',
        error: undefined,
        observation: ['replaced', 'observed'],
      });
      expect(await statuses()).toEqual([
        [original, 'replaced', 'observed', undefined],
        [winner, 'included', 'observed', undefined],
      ]);
      // Final: the winner is proven, and the original is proven replaced by it.
      env.node.mine(5);
      expect(await pass(env, sub.operationId, 1)).toEqual({
        state: 'final',
        error: undefined,
        observation: ['replaced', 'proven'],
      });
      expect(await statuses()).toEqual([
        [original, 'replaced', 'proven', winner],
        [winner, 'final', 'proven', undefined],
      ]);
      expect(await env.run(env.bc.getOperation(sub.operationId))).toMatchObject({
        state: 'final',
        outcome,
        activeAttempt: { id: winner },
      });
    },
  );
});

describe("a node's rejection is a claim (lesson 21: F3-R11, F3-R13)", () => {
  it.each([
    ['Blockstream', 'sendrawtransaction RPC error -26: bad-txns-inputs-duplicate'],
    [
      'mempool/electrs',
      `sendrawtransaction RPC error: ${JSON.stringify({ code: -26, message: 'bad-txns-inputs-duplicate' })}`,
    ],
  ])(
    'keeps the Operation alive when a lone endpoint relays our bytes, then claims them invalid (%s)',
    async (_format, text) => {
      const { signer, calls } = countingSigner();
      const env = await createUtxoEnv({ signer, fund: [100_000n] });
      // The index has not seen the relayed transaction yet: the engine's own-ref lookup misses.
      env.node.setMempoolDelay('a', 30_000);
      env.node.intercept('a', (request, _signal, honest) => {
        if (request.method !== 'POST') return undefined;
        honest(); // relayed: the node holds it
        return { status: 400, text };
      });
      await expect(
        env.run(
          env.bc.transfer(
            { to: env.stranger(), amount: 50_000n },
            { idempotencyKey: 'k' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'TX_REFUSED' });
      env.node.clearIntercept('a');
      const op = await env.stores.operations.getByKey('default', 'k');
      const ref = op?.attempts[0]?.ref.id ?? '';
      // Refused, never rejected: the Operation stalls and keeps its input.
      expect(op).toMatchObject({
        state: 'stalled',
        error: { code: 'TX_REFUSED' },
        reservation: { kind: 'inputs' },
      });
      expect(
        await env.stores.operations.getObservation(op?.attempts[0]?.id ?? ''),
      ).toMatchObject({ state: 'refused', evidence: 'observed' });
      expect(env.node.inMempool(ref)).toBe(true);
      // A retry cannot take the coin the relayed transaction spends.
      await expect(
        env.run(env.bc.transfer({ to: env.stranger(), amount: 10_000n })),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      // The index catches up: live again, and it is our payment that lands.
      await env.clock.advance(30_000);
      expect(await env.run(env.bc.getOperation(op?.id ?? ''))).toMatchObject({
        state: 'stalled',
      });
      await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
      expect(await env.run(env.bc.getOperation(op?.id ?? ''))).toMatchObject({
        state: 'submitted',
      });
      env.node.mine(6);
      const done = await env.run(
        env.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' }),
      );
      expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect(env.node.sendCount(ref)).toBe(1);
      expect(calls()).toBe(1);
    },
  );
});

describe('replacements over descendants, and stalled Operations (M4, F3-R14)', () => {
  it('refuses a replacement below the fees of the descendants it would evict; a higher fee wins (M4)', async () => {
    const env = await createUtxoEnv();
    const payee = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
    const sub = await env.run(
      env.bc.transfer({ to: payee.address, amount: 50_000n, fee: 'slow' }),
    );
    const original = sub.attempt?.id ?? '';
    // The payee spends its output at once, paying 5,000 sat: a descendant of ours (CPFP).
    const vout = (env.node.transaction(original)?.outs ?? []).findIndex(
      (o) => toHex(o.script) === toHex(payee.script),
    );
    const child = env.node.submit(
      signedSpend(OTHER_KEY, [[original, vout, 50_000n]], [[payee.script, 45_000n]]),
    );
    // The driver's floor counts the replaced fee only; bitcoind's rule 3 counts every
    // transaction a replacement evicts. 'fast' (20 sat/vB) clears the floor, not the child.
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    expect([env.node.inMempool(original), env.node.inMempool(child)]).toEqual([
      true,
      true,
    ]);
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op).toMatchObject({ state: 'submitted', activeAttempt: { id: original } });
    expect(op?.error).toBeUndefined();
    // 100 sat/vB pays for the child too: the replacement evicts both, and it wins.
    const replaced = await env.run(
      env.bc.replace(sub.operationId, { fee: { satPerVByte: 100n } }),
    );
    const replacement = replaced.attempt?.id ?? '';
    expect([
      env.node.inMempool(original),
      env.node.inMempool(child),
      env.node.inMempool(replacement),
    ]).toEqual([false, false, true]);
    const done = await finalOf(env, sub.operationId);
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect((await env.run(env.bc.getBalance(payee.address))).amount.base).toBe(50_000n);
  });

  it('never releases a stalled signed Operation by hand, but cancels it once a node accepts (F3-R14)', async () => {
    const env = await createUtxoEnv({ fund: [100_000n] });
    const to = env.stranger();
    // A node that refuses every transaction with a claim our bytes disprove (lesson 21).
    env.node.intercept('a', (request) =>
      request.method === 'POST'
        ? {
            status: 400,
            text: 'sendrawtransaction RPC error -26: bad-txns-in-belowout, value in (0.001) < value out (0.002)',
          }
        : undefined,
    );
    await expect(
      env.run(env.bc.transfer({ to, amount: 50_000n }, { idempotencyKey: 'k' })),
    ).rejects.toMatchObject({ code: 'TX_REFUSED' });
    const stalled = await env.stores.operations.getByKey('default', 'k');
    const id = stalled?.id ?? '';
    const original = stalled?.attempts[0]?.ref.id ?? '';
    expect(await env.run(env.bc.getOperation(id))).toMatchObject({ state: 'stalled' });
    expect(env.node.sendCount(original)).toBe(0); // never relayed
    // Signed bytes exist and a node may hold them: nothing releases the input by hand.
    await expect(env.run(env.bc.abandon(id))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 10_000n })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // The same node refuses the cancel: still stalled, the input still held.
    await expect(env.run(env.bc.cancel(id))).rejects.toMatchObject({
      code: 'TX_REFUSED',
    });
    expect(await env.run(env.bc.getOperation(id))).toMatchObject({ state: 'stalled' });
    // An honest node takes the next (bumped) cancel, and it wins.
    env.node.clearIntercept('a');
    const cancelled = await env.run(env.bc.cancel(id));
    const cancel = cancelled.attempt?.id ?? '';
    expect(env.node.inMempool(cancel)).toBe(true);
    const done = await finalOf(env, id);
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    const record = await env.stores.operations.get('default', id);
    const paid =
      record?.attempts.find((a) => a.ref.id === cancel)?.fee.charges[0]?.amount ?? 0n;
    expect(paid).toBeGreaterThan(0n);
    expect((await env.run(env.bc.getBalance(env.address))).amount.base).toBe(
      100_000n - paid,
    );
    expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(0n);
    expect(env.node.confirmations(original)).toBe(0);
  });
});
