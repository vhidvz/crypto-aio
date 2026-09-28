import { VersionedTransaction } from '@solana/web3.js';
import type { AioEvent, OperationPatch, ScanEvent } from '../../../src';
import type { SolanaExpiryOrdering } from '../../../src/adapters/solana';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { native } from '../../../src/native';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import {
  createAssociatedTokenAccountIdempotent,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { TOKEN, associatedAddress } from './support/node';
import { signedTx } from './support/tx';
import { countingSigner, createSolanaEnv } from './support/env';
import { MINT, RECIPIENT } from './support/vectors';

const SOL = 1_000_000_000n;
const JUNK = 'So11111111111111111111111111111111111111112';
/** agave's MAX_PROCESSING_AGE: a blockhash's last valid height is its block's plus this. */
const VALIDITY = 150n;

type Env = Awaited<ReturnType<typeof createSolanaEnv>>;

/** The expiry ordering the build recorded on an Operation's first Attempt. */
async function orderingOf(env: Env, operationId: string): Promise<SolanaExpiryOrdering> {
  const op = await env.stores.operations.get('default', operationId);
  return op?.attempts[0]?.ordering as SolanaExpiryOrdering;
}

/** Produces one block per fake 400 ms (the monitor polling meanwhile) until `done()`. */
async function produceUntil(env: Env, done: () => boolean, maxBlocks = 1_000) {
  for (let i = 0; i < maxBlocks && !done(); i++) {
    env.node.produce();
    await env.clock.advance(400);
  }
  if (!done()) throw new Error(`not reached within ${maxBlocks} blocks`);
}

/** Holds a transaction back from every leader: dropped, and every resend swallowed. */
function holdBack(env: Env, signature: string): void {
  env.node.drop(signature);
  env.node.intercept = (_endpoint, method) =>
    method === 'sendTransaction' ? { result: signature } : undefined;
}

interface LatestBlockhash {
  readonly context: { readonly apiVersion: string; readonly slot: number };
  readonly value: { readonly blockhash: string; readonly lastValidBlockHeight: number };
}

/** A build-time lie (lesson 17): every endpoint alters its `getLatestBlockhash` answer. */
function lieAtBuild(env: Env, alter: (answer: LatestBlockhash) => LatestBlockhash): void {
  env.node.intercept = (endpoint, method, params) =>
    method === 'getLatestBlockhash'
      ? { result: alter(env.node.answer(endpoint, method, params) as LatestBlockhash) }
      : undefined;
}

/** The finalized `getBlock` reads each endpoint served at `details` ('none': headers). */
function finalizedBlockReads(env: Env, details: 'none' | 'signatures') {
  return env.node.served.filter((s) => {
    const options = s.params[1] as Record<string, unknown> | undefined;
    return (
      s.method === 'getBlock' &&
      options?.commitment === 'finalized' &&
      options.transactionDetails === details
    );
  });
}

/** The node's finalized height when an Operation of this container first became `expired`. */
function onExpired(env: Env): { height?: bigint } {
  const seen: { height?: bigint } = {};
  env.aio.on('operation.state', (event) => {
    if (event.to === 'expired' && seen.height === undefined) {
      seen.height = env.node.finalized.height;
    }
  });
  return seen;
}

describe('Solana end to end', () => {
  // Lesson 1, R46: the container builds its transports itself with the core's default
  // jitter (`Math.random`), which the public options cannot fix; it is fixed here instead.
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs a native transfer with a memo to proven finality', async () => {
    const env = await createSolanaEnv();
    const sub = await env.run(
      env.bc.transfer(
        { to: RECIPIENT, amount: '1.5', memo: 'order-7' },
        { idempotencyKey: 'n1' },
      ),
    );
    expect(sub).toMatchObject({
      state: 'submitted',
      attempt: { idKind: 'signature', canonical: true },
    });
    const final = await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(final.status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    expect(env.node.balance(RECIPIENT)).toBe(1_500_000_000n);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers).toEqual([
      expect.objectContaining({
        id: `${sub.attempt?.id}:ix:2`,
        memo: 'order-7',
        amount: expect.objectContaining({ base: 1_500_000_000n }),
      }),
    ]);
    expect(tx?.decoding).toBe('complete');
  });

  it('sends SPL tokens by mint, creating the recipient account and charging its rent', async () => {
    const env = await createSolanaEnv();
    env.node.createMint(MINT, 6);
    env.node.mintTo(MINT, env.address, 10_000_000n);
    const asset = { standard: 'spl', contract: MINT };
    const fee = await env.run(env.bc.estimateFee({ to: RECIPIENT, amount: '2', asset }));
    expect(fee.bound).toBe('upper');
    expect(fee.charges.map((c) => c.label)).toEqual(['network', 'priority', 'rent']);
    expect(fee.charges[0]?.amount.base).toBe(5_000n);
    // The build variant adds at most ~1 lamport per 1,000 compute units.
    expect(fee.charges[1]?.amount.base).toBeLessThanOrEqual(50n);
    expect(fee.charges[2]?.amount.toDecimalString()).toBe('0.00148844');
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: '2', asset }));
    await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(env.node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
    expect(env.node.balance(associatedAddress(RECIPIENT, MINT))).toBe(1_488_440n);
    await expect(
      env.run(env.bc.transfer({ to: RECIPIENT, amount: '9', asset })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('lands five concurrent transfers from one address (expiry ordering needs no lease)', async () => {
    const env = await createSolanaEnv();
    const acquire = jest.spyOn(env.stores.locks, 'acquire');
    const subs = await env.run(
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          env.bc.transfer(
            { to: RECIPIENT, amount: SOL + BigInt(i) },
            { idempotencyKey: `c${i}` },
          ),
        ),
      ),
      10,
    );
    expect(new Set(subs.map((s) => s.attempt?.id)).size).toBe(5);
    const finals = await env.produceWhile(
      Promise.all(subs.map((s) => s.wait({ finality: 'final' }))),
    );
    expect(finals.every((f) => f.status.state === 'final')).toBe(true);
    expect(env.node.balance(RECIPIENT)).toBe(5n * SOL + 10n);
    // Each Operation's own signing lock (R24), never the address lease (`seq:…`).
    const keys = acquire.mock.calls.map(([key]) => key);
    const own = subs.map((s) => `op:default:${s.operationId}`);
    expect(own.every((key) => keys.includes(key))).toBe(true);
    expect(keys.filter((key) => key.startsWith('seq:'))).toEqual([]);
  });

  it('keeps two identical Operations apart: two payments, two signatures', async () => {
    const env = await createSolanaEnv();
    const [a, b] = await env.run(
      Promise.all([
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'same-1' }),
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'same-2' }),
      ]),
      10,
    );
    expect(a?.attempt?.id).not.toBe(b?.attempt?.id);
    await env.produceWhile(
      Promise.all([a!.wait({ finality: 'final' }), b!.wait({ finality: 'final' })]),
    );
    expect(env.node.balance(RECIPIENT)).toBe(2n * SOL);
  });

  it('rebroadcasts identical bytes while the blockhash is valid, as "already processed" after', async () => {
    const env = await createSolanaEnv({
      lifecycle: { droppedGracePeriodMs: 2_000, rebroadcastIntervalMs: 1_000 },
    });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }));
    const id = sub.attempt?.id ?? '';
    env.node.drop(id); // the leader never got it: no mempool on Solana
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    await env.clock.advance(3_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    expect(env.node.sendCount(id)).toBeGreaterThanOrEqual(2);
    const final = await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(final.status.state).toBe('final');
    // The same bytes again: the node knows them ("already processed"), nothing is paid twice.
    const attempt = (await env.stores.operations.get('default', sub.operationId))
      ?.attempts[0];
    const sent = env.node.served.filter((s) => s.method === 'sendTransaction');
    expect(new Set(sent.map((s) => s.params[0]))).toEqual(new Set([attempt?.raw.data]));
    expect(() => env.node.submit(attempt?.raw.data ?? '')).toThrow(
      'Transaction simulation failed: This transaction has already been processed',
    );
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('proves expiry only past the attested lastValidBlockHeight, from every finalized block of the window, then rebuilds', async () => {
    const { signer, calls } = countingSigner();
    const env = await createSolanaEnv({ endpoints: ['a', 'b'], signer });
    const builtAt = env.node.head;
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 2n * SOL }, { idempotencyKey: 'e1' }),
    );
    const id = sub.attempt?.id ?? '';
    // F5-R9: the ordering names the message's blockhash and its block's slot.
    const stored = (await env.stores.operations.get('default', sub.operationId))
      ?.attempts[0];
    const ordering = stored?.ordering as SolanaExpiryOrdering;
    expect(ordering).toEqual({
      kind: 'expiry',
      lastValidHeight: builtAt.height + VALIDITY,
      blockhash: builtAt.hash,
      blockhashSlot: builtAt.slot,
    });
    const message = VersionedTransaction.deserialize(
      Buffer.from(stored?.raw.data ?? '', 'base64'),
    ).message;
    expect(message.recentBlockhash).toBe(ordering.blockhash);
    const last = ordering.lastValidHeight;
    const expired = onExpired(env);
    // Every node loses it and never accepts it again.
    holdBack(env, id);
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    const waiting = sub.wait({ finality: 'final' }).catch((e: unknown) => e);
    // Block L is final everywhere and the monitor polled there: it can still land at L + 1.
    await produceUntil(env, () => env.node.finalized.height >= last);
    await env.clock.advance(3_000);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    env.node.served.length = 0;
    const outcome = await env.produceWhile(waiting);
    expect(outcome).toMatchObject({ code: 'TX_EXPIRED' });
    expect(expired.height).toBeGreaterThanOrEqual(last + 1n);
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op?.state).toBe('expired');
    // The anchor: both endpoints' finalized block at the recorded slot, which carries the
    // blockhash (so the height is the quorum's, not the build's).
    const anchors = finalizedBlockReads(env, 'none').filter(
      (s) => Number(s.params[0]) === Number(ordering.blockhashSlot),
    );
    expect(new Set(anchors.map((s) => s.endpoint))).toEqual(new Set(['a', 'b']));
    // The window: every block from L − 149 through L + 1 (151), read whole on both endpoints.
    const window = Array.from({ length: 151 }, (_, i) =>
      Number(env.node.block(last - 149n + BigInt(i))?.slot),
    );
    for (const endpoint of ['a', 'b']) {
      const read = finalizedBlockReads(env, 'signatures')
        .filter((s) => s.endpoint === endpoint)
        .map((s) => Number(s.params[0]));
      expect([...new Set(read)].sort((x, y) => x - y)).toEqual(window);
    }
    env.node.intercept = undefined;
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    expect(rebuilt.attempts.map((a) => a.purpose)).toEqual(['original', 'rebuild']);
    const done = await env.produceWhile(rebuilt.wait({ finality: 'final' }));
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.landed(id)).toBeUndefined();
    expect([env.node.balance(RECIPIENT), calls()]).toEqual([2n * SOL, 2]);
  });

  it('never calls an expired-looking transfer dead while it can still land (Review Focus 1)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', { name: 'b', lag: 4 }] });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'late' }),
    );
    const id = sub.attempt?.id ?? '';
    env.node.drop(id);
    // Past lastValidBlockHeight on endpoint a only: b still trails by four blocks.
    env.node.produce(150 + 3);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).not.toBe(
      'expired',
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    // Once b's finalized block passes lastValidBlockHeight + 1 too, the quorum proves it.
    env.node.produce(4);
    await env.clock.advance(2_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('expired');
  });

  it('never proves expiry from a lowered lastValidBlockHeight: the transfer lands after it (lesson 17, F5-R10)', async () => {
    const { signer, calls } = countingSigner();
    const env = await createSolanaEnv({ endpoints: ['a', 'b'], signer });
    const builtAt = env.node.head;
    // The endpoint the build asks claims a last valid height 100 blocks too low.
    lieAtBuild(env, (answer) => ({
      ...answer,
      value: {
        ...answer.value,
        lastValidBlockHeight: answer.value.lastValidBlockHeight - 100,
      },
    }));
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'low' }),
    );
    const id = sub.attempt?.id ?? '';
    const recorded = (await orderingOf(env, sub.operationId)).lastValidHeight;
    expect(recorded).toBe(builtAt.height + VALIDITY - 100n);
    const waiting = sub.wait({ finality: 'final' });
    waiting.catch(() => undefined);
    // Held back until the lie's whole window is final everywhere, the monitor polling.
    holdBack(env, id);
    await produceUntil(env, () => env.node.finalized.height > recorded + 5n);
    await env.clock.advance(3_000);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    // The leaders take it again: the monitor's resend lands it past the lied height.
    env.node.intercept = undefined;
    const final = await env.produceWhile(waiting);
    expect(final.status.state).toBe('final');
    expect(final.status.blockHeight).toBeGreaterThan(recorded + 1n);
    expect(final.status.blockHeight).toBeLessThanOrEqual(builtAt.height + VALIDITY + 1n);
    expect([
      env.node.balance(RECIPIENT),
      calls(),
      final.operation?.attempts.length,
    ]).toEqual([SOL, 1, 1]);
  });

  it('proves expiry at the recorded height when the recorded slot does not hold the blockhash (F5-R11 fallback)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const builtAt = env.node.head;
    // The build's answer names the slot of the block before the blockhash's own.
    lieAtBuild(env, (answer) => ({
      ...answer,
      context: { ...answer.context, slot: answer.context.slot - 1 },
    }));
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'slot' }),
    );
    const id = sub.attempt?.id ?? '';
    const ordering = await orderingOf(env, sub.operationId);
    expect(ordering).toMatchObject({
      lastValidHeight: builtAt.height + VALIDITY,
      blockhash: builtAt.hash,
    });
    expect(ordering.blockhashSlot).not.toBe(builtAt.slot);
    const expired = onExpired(env);
    holdBack(env, id);
    const outcome = await env.produceWhile(
      sub.wait({ finality: 'final' }).catch((e: unknown) => e),
    );
    expect(outcome).toMatchObject({ code: 'TX_EXPIRED' });
    expect(expired.height).toBeGreaterThanOrEqual(ordering.lastValidHeight + 1n);
    env.node.intercept = undefined;
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    const done = await env.produceWhile(rebuilt.wait({ finality: 'final' }));
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('decides nothing when neither the recorded slot nor the recorded height holds the blockhash (F5-R13)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const builtAt = env.node.head;
    lieAtBuild(env, (answer) => ({
      context: { ...answer.context, slot: answer.context.slot - 1 },
      value: {
        ...answer.value,
        lastValidBlockHeight: answer.value.lastValidBlockHeight - 1,
      },
    }));
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'both' }),
    );
    const id = sub.attempt?.id ?? '';
    const waiting = sub.wait({ finality: 'final' });
    waiting.catch(() => undefined);
    holdBack(env, id);
    // Well past the real window, final everywhere: still never expired, so never rebuilt.
    await produceUntil(
      env,
      () => env.node.finalized.height > builtAt.height + VALIDITY + 10n,
    );
    await env.clock.advance(3_000);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(env.node.balance(RECIPIENT)).toBe(0n);
  });

  it('stalls on insufficient funds, then lands its own bytes after a top-up and a rebroadcast', async () => {
    const { signer, calls } = countingSigner();
    const env = await createSolanaEnv({ fund: 3n * SOL, signer });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 2n * SOL }));
    const id = sub.attempt?.id ?? '';
    // Spend the balance behind the library's back before its transaction lands.
    env.node.drop(id);
    env.node.fund(env.address, -2n * SOL);
    await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('stalled');
    env.node.fund(env.address, 2n * SOL);
    expect((await env.run(env.bc.rebroadcast(sub.operationId))).state).toBe('submitted');
    await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(env.node.balance(RECIPIENT)).toBe(2n * SOL);
    // The stored bytes, signed once: every send carried them, and they landed.
    const stored =
      (await env.stores.operations.get('default', sub.operationId))?.attempts ?? [];
    const sent = env.node.served.filter((s) => s.method === 'sendTransaction');
    expect(new Set(sent.map((s) => s.params[0]))).toEqual(new Set([stored[0]?.raw.data]));
    expect([stored.length, calls(), env.node.landed(id)?.err]).toEqual([1, 1, null]);
  });

  it('decides a fork only when both endpoints serve the new block at the height (M11)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const disagreements: AioEvent[] = [];
    env.aio.on('provider.inconsistent', (e) => disagreements.push(e));
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }));
    const ref = sub.attempt?.id ?? '';
    env.node.produce(1);
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const orphan = env.node.landed(ref)?.block;
    if (!orphan) throw new Error('not landed');
    env.node.reorg(1, [ref]);
    env.node.produce(1);
    const replacement = env.node.block(orphan.height);
    expect(replacement?.hash).not.toBe(orphan.hash);
    // The orphan check reads the block at the recorded height (lesson 17) from both
    // endpoints. While b still serves the orphaned block there, the quorum disagrees, which
    // decides nothing: no reorg, no resend.
    let bLags = true;
    env.node.intercept = (endpoint, method, params) =>
      bLags &&
      endpoint === 'b' &&
      method === 'getBlock' &&
      Number(params[0]) === Number(replacement?.slot)
        ? {
            result: {
              blockHeight: Number(orphan.height),
              blockTime: orphan.blockTime,
              blockhash: orphan.hash,
              parentSlot: Number(orphan.parentSlot),
              previousBlockhash: orphan.previousBlockhash,
            },
          }
        : undefined;
    const waiting = env.bc.waitForConfirmation(sub.operationId, { finality: 'final' });
    waiting.catch(() => undefined);
    for (let i = 0; i < 10; i++) {
      env.node.produce();
      await env.clock.advance(1_000);
    }
    expect([reorgs.length, env.node.sendCount(ref)]).toEqual([0, 1]);
    expect(disagreements.length).toBeGreaterThan(0);
    for (const event of disagreements) {
      expect(event).toMatchObject({
        method: 'getBlock',
        endpointIds: ['node/a', 'node/b'],
      });
    }
    bLags = false;
    const final = await env.produceWhile(waiting);
    expect(final.operation?.state).toBe('final');
    expect(reorgs[0]).toMatchObject({
      operationId: sub.operationId,
      previousBlockHash: orphan.hash,
    });
    expect(env.node.sendCount(ref)).toBeGreaterThanOrEqual(2);
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('ends final, never expired, when the transfer lands at lastValidBlockHeight + 1 (I1)', async () => {
    const env = await createSolanaEnv();
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'edge' }),
    );
    const ref = sub.attempt?.id ?? '';
    const op = await env.stores.operations.getByKey('default', 'edge');
    const attempt = op?.attempts[0];
    const last =
      attempt?.ordering.kind === 'expiry'
        ? (attempt.ordering.lastValidHeight as bigint)
        : 0n;
    // Held back from every leader until its last block, then sent once; the monitor polls
    // (and resends) all along, and must never prove it expired.
    holdBack(env, ref);
    const waiting = sub.wait({ finality: 'final' });
    waiting.catch(() => undefined);
    while (env.node.head.height < last) {
      env.node.produce();
      await env.clock.advance(400);
    }
    env.node.intercept = undefined;
    env.node.submit(attempt?.raw.data ?? '', { skipPreflight: true });
    env.node.produce(1);
    expect(env.node.landed(ref)?.block.height).toBe(last + 1n);
    const final = await env.produceWhile(waiting);
    expect(final.status).toMatchObject({ state: 'final', blockHeight: last + 1n });
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('never proves expiry while every index misses a transfer landed at lastValidBlockHeight + 1 (I1, lesson 16)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'unindexed' }),
    );
    const ref = sub.attempt?.id ?? '';
    const attempt = (await env.stores.operations.get('default', sub.operationId))
      ?.attempts[0];
    const last = (attempt?.ordering as SolanaExpiryOrdering).lastValidHeight;
    // Sent once at its last block, it lands at L + 1; no endpoint's transaction index shows
    // it, so only the window's blocks can tell.
    let indexed = false;
    holdBack(env, ref);
    const held = env.node.intercept;
    env.node.intercept = (endpoint, method, params) =>
      !indexed && method === 'getTransaction' && params[0] === ref
        ? { result: null }
        : held?.(endpoint, method, params);
    const waiting = sub.wait({ finality: 'final' });
    waiting.catch(() => undefined);
    await produceUntil(env, () => env.node.head.height >= last);
    env.node.submit(attempt?.raw.data ?? '', { skipPreflight: true });
    env.node.produce(1);
    const holder = env.node.landed(ref)?.block;
    expect(holder?.height).toBe(last + 1n);
    // Past the window everywhere: the expiry predicate holds, and the window's last block
    // holds the transaction, so nothing is decided.
    env.node.served.length = 0;
    await produceUntil(env, () => env.node.finalized.height > last + 8n);
    await env.clock.advance(3_000);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    const found = finalizedBlockReads(env, 'signatures').filter(
      (s) => Number(s.params[0]) === Number(holder?.slot),
    );
    expect(new Set(found.map((s) => s.endpoint))).toEqual(new Set(['a', 'b']));
    indexed = true;
    const final = await env.produceWhile(waiting);
    expect(final.status).toMatchObject({ state: 'final', blockHeight: last + 1n });
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  describe('crash and recovery (handoff R20: killPrevious)', () => {
    async function crashEnv() {
      const { signer, calls } = countingSigner();
      const faulty = new FaultyOperationStore(new MemoryOperationStore());
      const env = await createSolanaEnv({ signer, stores: { operations: faulty } });
      return { env, faulty, calls };
    }
    const patchState = (state: string) => (args: readonly unknown[]) =>
      (args[2] as OperationPatch | undefined)?.state === state;
    const sends = (env: Env) =>
      env.node.served
        .filter((s) => s.method === 'sendTransaction')
        .map((s) => s.params[0]);

    it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.sendCount(ref)]).toEqual(['signed', 0]);
      const dead = env.bc;
      const restarted = env.restart({ killPrevious: true });
      // M11: the crashed process is dead: nothing on its handle settles any more.
      let deadSettled = false;
      void dead.getBlockHeight().then(
        () => (deadSettled = true),
        () => (deadSettled = true),
      );
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
      // The stored bytes, as signed before the crash.
      expect(sends(env)).toEqual([stored?.attempts[0]?.raw.data]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
      expect(deadSettled).toBe(false);
    });

    it('recovers a broadcast that was never recorded: the node answers "already processed"', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({
        method: 'update',
        timing: 'before',
        when: patchState('submitted'),
      });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.inMempool(ref)]).toEqual(['signed', true]);
      env.node.produce(1);
      expect(env.node.landed(ref)?.err).toBeNull();
      const restarted = env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      // The stored bytes again, which the node already processed.
      expect(env.node.sendCount(ref)).toBe(2);
      expect(new Set(sends(env))).toEqual(new Set([stored?.attempts[0]?.raw.data]));
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['included', 1]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
    });

    it('resumes a prepared transfer by signing its stored message once', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'update', timing: 'after', when: patchState('prepared') });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      expect((await env.stores.operations.getByKey('default', 'k'))?.state).toBe(
        'prepared',
      );
      const restarted = env.restart({ killPrevious: true });
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['submitted', 1]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
      expect(env.clock.pending).toBe(0);
    });
  });

  describe("a node's rejection is a claim (lesson 21, F5-R15)", () => {
    const PREFLIGHT_CLAIM = {
      error: {
        code: -32002,
        message:
          'Transaction simulation failed: Transaction did not pass signature verification',
        data: { err: 'SignatureFailure', logs: [], accounts: null },
      },
    };
    const VERIFICATION_CLAIM = {
      error: { code: -32003, message: 'Transaction signature verification failure' },
    };

    /** Every Operation state this container moved to. */
    function statesOf(env: Env): string[] {
      const states: string[] = [];
      env.aio.on('operation.state', (event) => states.push(event.to));
      return states;
    }

    it('keeps the Operation when a lone endpoint claims a bad signature and keeps the bytes, then lands them once', async () => {
      const { signer, calls } = countingSigner();
      const env = await createSolanaEnv({ signer });
      const states = statesOf(env);
      // The only endpoint keeps the bytes, relays nothing, and claims a bad signature.
      const kept: string[] = [];
      env.node.intercept = (_endpoint, method, params) => {
        if (method !== 'sendTransaction') return undefined;
        kept.push(params[0] as string);
        return PREFLIGHT_CLAIM;
      };
      const intent = { to: RECIPIENT, amount: SOL };
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'TX_REFUSED' });
      const op = await env.stores.operations.getByKey('default', 'k');
      const ref = op?.attempts[0]?.ref.id ?? '';
      // Not terminal: a caller has no reason to pay again, and no rebuild is allowed.
      expect(op?.state).toBe('stalled');
      await expect(env.run(env.bc.rebuild(op?.id ?? ''))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
      const waiting = env.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' });
      waiting.catch(() => undefined);
      await produceUntil(env, () => env.node.head.height >= 12n);
      // Later, it relays the bytes it kept: they land, and the Operation confirms.
      env.node.intercept = undefined;
      expect(new Set(kept)).toEqual(new Set([op?.attempts[0]?.raw.data]));
      env.node.submit(kept[0] ?? '');
      const final = await env.produceWhile(waiting);
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect(env.node.landed(ref)?.err).toBeNull();
      expect([env.node.balance(RECIPIENT), calls()]).toEqual([SOL, 1]);
      expect(states).not.toContain('failed');
    });

    it('keeps the Operation when a lone endpoint relays the bytes but claims a bad signature', async () => {
      const { signer, calls } = countingSigner();
      const env = await createSolanaEnv({ signer });
      const states = statesOf(env);
      let relayed = false;
      env.node.intercept = (_endpoint, method, params) => {
        if (method !== 'sendTransaction') return undefined;
        if (!relayed) {
          relayed = true;
          env.node.submit(params[0] as string);
        }
        return VERIFICATION_CLAIM;
      };
      const sub = env.bc.transfer(
        { to: RECIPIENT, amount: SOL },
        { idempotencyKey: 'k' },
      );
      await expect(env.run(sub)).rejects.toMatchObject({ code: 'TX_REFUSED' });
      const op = await env.stores.operations.getByKey('default', 'k');
      expect([op?.state, relayed]).toEqual(['stalled', true]);
      const final = await env.produceWhile(
        env.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' }),
      );
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect([env.node.balance(RECIPIENT), calls()]).toEqual([SOL, 1]);
      expect(states).not.toContain('failed');
    });

    it('lets the expiry proof end an Operation whose bytes the claiming endpoint never relays', async () => {
      const { signer, calls } = countingSigner();
      const env = await createSolanaEnv({ signer });
      const states = statesOf(env);
      env.node.intercept = (_endpoint, method) =>
        method === 'sendTransaction' ? VERIFICATION_CLAIM : undefined;
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'TX_REFUSED' });
      const op = await env.stores.operations.getByKey('default', 'k');
      const last = (op?.attempts[0]?.ordering as SolanaExpiryOrdering).lastValidHeight;
      // Stalled, not failed, until the window is proven: only then may it be rebuilt.
      const outcome = await env.produceWhile(
        env.bc
          .waitForConfirmation(op?.id ?? '', { finality: 'final' })
          .catch((e: unknown) => e),
      );
      expect(outcome).toMatchObject({ code: 'TX_EXPIRED' });
      expect(env.node.finalized.height).toBeGreaterThan(last);
      expect(states).toEqual(expect.arrayContaining(['stalled', 'expired']));
      expect(states).not.toContain('failed');
      env.node.intercept = undefined;
      const rebuilt = await env.run(env.bc.rebuild(op?.id ?? ''));
      const done = await env.produceWhile(rebuilt.wait({ finality: 'final' }));
      expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect([env.node.balance(RECIPIENT), calls()]).toEqual([SOL, 2]);
    });
  });

  it('scans final blocks for deposits: native, SPL, and an unresolved token (R35)', async () => {
    const env = await createSolanaEnv();
    env.node.createMint(MINT, 6);
    env.node.mintTo(MINT, env.address, 10_000_000n);
    const subs = [];
    subs.push(
      await env.run(
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'd1' }),
      ),
    );
    subs.push(
      await env.run(
        env.bc.transfer(
          { to: RECIPIENT, amount: 2n, asset: { standard: 'spl', contract: MINT } },
          { idempotencyKey: 'd2' },
        ),
      ),
    );
    await env.produceWhile(Promise.all(subs.map((s) => s.wait({ finality: 'final' }))));
    // Another wallet's token whose mint no longer parses: its deposit is unresolved (R35).
    env.node.createMint(JUNK, 6);
    const source = env.node.mintTo(JUNK, env.address, 10n);
    const destination = associatedAddress(RECIPIENT, JUNK);
    env.node.submit(
      signedTx(env.node.head.hash, [
        createAssociatedTokenAccountIdempotent(env.address, destination, RECIPIENT, JUNK),
        transferChecked(source, JUNK, destination, env.address, 5n, 6),
      ]),
    );
    env.node.produce(1);
    env.node.setAccount(JUNK, { owner: TOKEN, data: new Uint8Array(82) });
    const scanner = env.bc
      .scanner({
        cursorKey: 'deposits',
        from: 1n,
        mode: 'final',
        filter: { addresses: [RECIPIENT] },
      })
      [Symbol.asyncIterator]();
    const seen: ScanEvent[] = [];
    for (
      let i = 0;
      i < 200 &&
      seen.flatMap((e) => (e.type === 'block' ? e.transactions : [])).length < 3;
      i++
    ) {
      const next = await env.produceWhile(scanner.next());
      if (next.done) break;
      await env.run(next.value.ack());
      seen.push(next.value);
    }
    const txs = seen.flatMap((e) => (e.type === 'block' ? e.transactions : []));
    expect(
      txs.map((t) =>
        t.transfers.map((tr) =>
          tr.unresolved ? tr.unresolved.code : tr.amount.format(),
        ),
      ),
    ).toEqual([
      ['1 SOL'],
      ['0.00148844 SOL', `0.000002 ${MINT.slice(0, 8)}`],
      ['0.00148844 SOL', 'ASSET_RESOLUTION'],
    ]);
    expect(txs[2]).toMatchObject({
      decoding: 'partial',
      transfers: [
        expect.anything(),
        { unresolved: { asset: { standard: 'spl', contract: JUNK }, amount: 5n } },
      ],
    });
  });

  it('hands the handle its own native Connection', async () => {
    const env = await createSolanaEnv();
    const client = await env.run(native(env.bc, '@solana/web3.js'));
    expect(await env.run(native(env.bc, '@solana/web3.js'))).toBe(client);
    expect(await env.run(client.getBlockHeight('confirmed'))).toBe(
      Number(env.node.head.height),
    );
    await env.aio.close();
  });
});
