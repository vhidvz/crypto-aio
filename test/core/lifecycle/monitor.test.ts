import { secp256k1 } from '@noble/curves/secp256k1';
import { internalsOf } from '../../../src/core/blockchain/internal';
import { containerOf } from '../../../src/core/container/internals';
import type { ChainReader, ProofSource } from '../../../src/core/driver/types';
import { noopLogger, type Logger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import {
  withLifecycleDefaults,
  type ReadTarget,
} from '../../../src/core/lifecycle/engine';
import { Monitor } from '../../../src/core/lifecycle/monitor';
import type { OrderingData } from '../../../src/core/model/ordering';
import { sequenceKey } from '../../../src/core/ordering/sequence';
import { secret } from '../../../src/core/secret/secret';
import { localSigner } from '../../../src/core/signing/local';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type {
  Fence,
  OperationPatch,
  OperationRecord,
} from '../../../src/core/store/types';
import type { Transport } from '../../../src/core/transport/types';
import { REVERT_ADDRESS, fakeAddress, signFake } from '../../../src/testing/fake-chain';
import {
  createFakeEnv,
  type FakeEnv,
  type FakeEnvOptions,
} from '../../../src/testing/env';
import { FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner, mineWhile } from './support';

describe('monitor', () => {
  it('reports confirmations, then finality with proven evidence', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    const included = await env.run(
      env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }),
    );
    expect(included.status).toMatchObject({
      state: 'included',
      evidence: 'observed',
      confirmations: 1,
    });
    const final = await mineWhile(
      env,
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('resolves a submission through wait()', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const result = await mineWhile(env, sub.wait({ confirmations: 2 }));
    expect(result.status.confirmations).toBeGreaterThanOrEqual(2);
  });

  it('survives a reorg that drops the transaction and still finalizes it', async () => {
    const env = await createFakeEnv();
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    env.chain.reorg(1, { drop: [ref] });
    expect(env.chain.inMempool(ref)).toBe(false);
    const final = await mineWhile(
      env,
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation?.state).toBe('final');
    expect(reorgs.length).toBeGreaterThanOrEqual(1);
    expect(env.chain.sendCount(ref)).toBeGreaterThanOrEqual(2);
  });

  it('never treats a dropped transaction as terminal and never frees its nonce', async () => {
    const env = await createFakeEnv({ lifecycle: { rebroadcastIntervalMs: 10_000_000 } });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.chain.dropFromMempool(ref);
    await env.clock.advance(11_000);
    const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(status).toMatchObject({ state: 'dropped', evidence: 'observed' });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    const next = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    expect(
      (await env.stores.operations.get('default', next.operationId))?.reservation,
    ).toEqual({ kind: 'nonce', nonce: 1n });
  });

  it('proves replacement by a conflicting transaction before failing the operation', async () => {
    const key = secp256k1.utils.randomPrivateKey();
    const env = await createFakeEnv({
      signer: localSigner({ id: 'hot', secp256k1: secret(key) }),
    });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.submit(
      signFake(
        {
          chainId: 'fake-local',
          from: env.address,
          to: env.stranger(),
          amount: '1',
          fee: '9',
          nonce: '0',
        },
        key,
      ),
    );
    await expect(
      mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({
      code: 'TX_REPLACED',
    });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('failed');
    expect(
      await env.stores.operations.getObservation(op?.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'replaced', evidence: 'proven' });
  });

  it('fails with TX_REVERTED only once the revert is final', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: REVERT_ADDRESS, amount: 5n }));
    env.chain.mine();
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'failed',
      evidence: 'observed',
    });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('included');
    await expect(
      mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({
      code: 'TX_REVERTED',
    });
  });

  it('expires a transaction only when expiry is proven on an expiry chain', async () => {
    const env = await createFakeEnv({
      ordering: 'expiry',
      lifecycle: { rebroadcastIntervalMs: 10_000_000 },
    });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.dropFromMempool(sub.attempt?.id ?? '');
    await expect(
      mineWhile(env, env.bc.waitForConfirmation(sub.operationId, { finality: 'final' })),
    ).rejects.toMatchObject({
      code: 'TX_EXPIRED',
    });
    expect((await env.stores.operations.get('default', sub.operationId))?.state).toBe(
      'expired',
    );
  });

  it('makes no terminal decision while providers disagree about finalized state', async () => {
    const env = await createFakeEnv({ endpoints: ['a', 'b'] });
    const inconsistent: AioEvent[] = [];
    env.aio.on('provider.inconsistent', (e) => inconsistent.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.configureEndpoint('b', { forkFinalized: true });
    await expect(
      mineWhile(
        env,
        env.bc.waitForConfirmation(sub.operationId, {
          finality: 'final',
          timeoutMs: 8_000,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(inconsistent.length).toBeGreaterThan(0);
    expect((await env.stores.operations.get('default', sub.operationId))?.state).not.toBe(
      'final',
    );
    env.chain.configureEndpoint('b', { forkFinalized: false });
    const final = await mineWhile(
      env,
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation?.state).toBe('final');
  });

  it('times out without changing state, and honours a pre-aborted signal', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    await expect(
      env.run(env.bc.waitForConfirmation(sub.operationId, { timeoutMs: 3_000 }), 500),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    expect((await env.stores.operations.get('default', sub.operationId))?.state).toBe(
      'submitted',
    );
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(
      env.bc.waitForConfirmation(sub.operationId, { signal: ctl.signal }),
    ).rejects.toThrow('stop');
  });

  it('streams status changes until the operation is final', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const states: string[] = [];
    const consume = (async () => {
      for await (const event of env.bc.watch(sub.operationId))
        states.push(event.status.state);
    })();
    await mineWhile(env, consume);
    expect(states).toContain('included');
    expect(states[states.length - 1]).toBe('final');
  });

  it('keeps seqno wallets strictly serial until the previous message is included', async () => {
    const env = await createFakeEnv({ ordering: 'seqno' });
    const first = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    await expect(
      env.run(env.bc.transfer({ to: env.stranger(), amount: 2n })),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_BUSY',
      retryable: true,
    });
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(first.operationId, { confirmations: 1 }));
    const second = await env.run(env.bc.transfer({ to: env.stranger(), amount: 2n }));
    expect(
      (await env.stores.operations.get('default', second.operationId))?.reservation,
    ).toMatchObject({ kind: 'seqno', seqno: 1n });
  });

  it('reports observation-level status for transactions it does not manage', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    const raw = await env.run(env.bc.getTransactionStatus(sub.attempt?.id ?? ''));
    expect(raw).toMatchObject({ state: 'included', confirmations: 1 });
    expect(await env.run(env.bc.getTransactionStatus('ab'.repeat(32)))).toMatchObject({
      state: 'unknown',
    });
  });
});

/** The container's monitor and a read target over the handle's own pooled driver. */
async function monitorOf(env: FakeEnv) {
  const internals = internalsOf(env.bc);
  const target: ReadTarget = {
    selection: internals.selection,
    pooled: await internals.pooled(),
  };
  return { monitor: containerOf(env.aio).monitor(), target };
}

async function stored(env: FakeEnv, operationId: string): Promise<OperationRecord> {
  const op = await env.stores.operations.get('default', operationId);
  if (!op) throw new Error(`operation ${operationId} not found`);
  return op;
}

function withHighest(transport: Transport, highest: () => bigint | undefined): Transport {
  return new Proxy(transport, {
    get(real, prop) {
      if (prop === 'highestHeight') return highest;
      const value: unknown = Reflect.get(real, prop);
      return typeof value === 'function' ? (value as () => unknown).bind(real) : value;
    },
  });
}

/** A transport with this effective `maxLagBlocks` and verified height (I2). */
function withLag(
  transport: Transport,
  maxLagBlocks: number,
  highest: () => bigint | undefined,
): Transport {
  return new Proxy(withHighest(transport, highest), {
    get(real, prop) {
      if (prop === 'maxLagBlocks') return maxLagBlocks;
      return Reflect.get(real, prop) as unknown;
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
  expect(
    await env.stores.operations.getObservation(op.activeAttemptId ?? ''),
  ).toMatchObject({ state: 'rejected', evidence: 'proven' });
  return { env, op };
}

/** A logger that records every warning's message and fields. */
function capturingLogger() {
  const warnings: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    ...noopLogger,
    warn: (message, fields) => warnings.push({ message, fields }),
    child: () => log,
  };
  return { log, warnings };
}

/** Holds the wallet's address lease for another owner. */
function holdLease(env: FakeEnv) {
  return env.stores.locks.acquire(
    sequenceKey('default', env.chainId, 'local', env.address),
    'elsewhere',
    600_000,
  );
}

describe('monitor: evidence and the monotonic height guard', () => {
  it("takes its lag tolerance from the transport's effective maxLagBlocks (I2)", async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    const { monitor, target } = await monitorOf(env);
    // transport.maxLagBlocks: 20, and this endpoint is 10 blocks behind the verified height.
    const tolerant: ReadTarget = {
      ...target,
      pooled: {
        ...target.pooled,
        transport: withLag(target.pooled.transport, 20, () => env.chain.head + 10n),
      },
    };
    const after = await env.run(
      monitor.check(tolerant, await stored(env, sub.operationId)),
    );
    expect(after.state).toBe('included');
  });

  it.each([
    ['no verified height is known', () => undefined],
    ['its head is more than maxLagBlocks behind', (head: bigint) => head + 3n],
  ])('decides nothing while the view is stale: %s', async (_case, highest) => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    const { monitor, target } = await monitorOf(env);
    const stale: ReadTarget = {
      ...target,
      pooled: {
        ...target.pooled,
        transport: withHighest(target.pooled.transport, () => highest(env.chain.head)),
      },
    };
    const before = await stored(env, sub.operationId);
    const after = await env.run(monitor.check(stale, before));
    expect(after).toEqual(before);
    expect(
      await env.stores.operations.getObservation(before.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'pending' });
    expect((await env.run(monitor.check(target, after))).state).toBe('included');
  });

  it('keeps an included transaction a lagging reader cannot see: absence proves no reorg', async () => {
    const env = await createFakeEnv();
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    env.chain.configureEndpoint('main', { lag: 1 });
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'included',
      confirmations: 1,
    });
    expect(reorgs).toEqual([]);
    expect((await stored(env, sub.operationId)).state).toBe('included');
  });

  it('moves an included operation back only when its block was proven orphaned', async () => {
    const env = await createFakeEnv();
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const orphaned = env.chain.block(1n)?.hash;
    env.chain.reorg(1, { drop: [ref] });
    const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(status).toMatchObject({ state: 'pending', confirmations: 0 });
    expect(status.blockHash).toBeUndefined();
    const op = await stored(env, sub.operationId);
    expect(op.state).toBe('submitted');
    expect(reorgs).toEqual([
      expect.objectContaining({
        operationId: op.id,
        attemptId: op.activeAttemptId,
        previousBlockHash: orphaned,
      }),
    ]);
  });

  it('follows a transaction into its new block after a reorg', async () => {
    const env = await createFakeEnv();
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    env.chain.reorg(1);
    const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(status).toMatchObject({
      state: 'included',
      blockHash: env.chain.block(1n)?.hash,
    });
    expect(reorgs).toHaveLength(1);
    expect((await stored(env, sub.operationId)).state).toBe('included');
  });

  it('orphans an included transaction on a quorum, never on one endpoint serving a fork (R33)', async () => {
    const env = await createFakeEnv({ endpoints: ['liar', 'honest'] });
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const recorded = env.chain.block(1n)?.hash;
    env.chain.configureEndpoint('liar', { forkAbove: 0 });
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'included',
      blockHash: recorded,
    });
    expect(reorgs).toEqual([]);
    expect((await stored(env, sub.operationId)).state).toBe('included');
    env.chain.configureEndpoint('liar', { forkAbove: undefined });
    env.chain.reorg(1, { drop: [ref] });
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'pending',
      confirmations: 0,
    });
    expect((await stored(env, sub.operationId)).state).toBe('submitted');
    expect(reorgs).toEqual([expect.objectContaining({ previousBlockHash: recorded })]);
  });

  it('does not follow one endpoint showing a transaction in another block without a quorum (R33)', async () => {
    const env = await createFakeEnv();
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const { monitor, target } = await monitorOf(env);
    const { reader } = target.pooled.driver;
    const lying: ReadTarget = {
      ...target,
      pooled: {
        ...target.pooled,
        driver: {
          ...target.pooled.driver,
          reader: {
            ...reader,
            observe: async (...args) => ({
              ...(await reader.observe(...args)),
              blockHash: 'f'.repeat(64),
            }),
          },
        },
      },
    };
    const op = await stored(env, sub.operationId);
    await env.run(monitor.check(lying, op));
    expect(reorgs).toEqual([]);
    expect(
      await env.stores.operations.getObservation(op.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'included', blockHash: env.chain.block(1n)?.hash });
  });

  it('never overwrites evidence another writer recorded while it was reading (R25)', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const { monitor, target } = await monitorOf(env);
    const op = await stored(env, sub.operationId);
    const attemptId = op.activeAttemptId ?? '';
    const store = env.stores.operations;
    const { reader } = target.pooled.driver;
    const racing: ChainReader = {
      ...reader,
      observe: async (...args) => {
        const seen = await reader.observe(...args);
        const current = await store.getObservation(attemptId);
        if (!current) throw new Error('unreachable');
        const { version, ...rest } = current;
        await store.putObservation(
          {
            ...rest,
            state: 'included',
            blockHeight: 1n,
            blockHash: 'b1',
            confirmations: 1,
          },
          version,
        );
        return seen;
      },
    };
    const checked = await env.run(
      monitor.check(
        {
          ...target,
          pooled: {
            ...target.pooled,
            driver: { ...target.pooled.driver, reader: racing },
          },
        },
        op,
      ),
    );
    expect(await store.getObservation(attemptId)).toMatchObject({
      state: 'included',
      blockHash: 'b1',
    });
    expect(checked.state).toBe('included');
  });

  it('refuses the transition of a worker whose claim was taken over', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const store = env.stores.operations;
    const [stale] = await store.claimDue('default', 'w1', env.clock.now(), 1_000, 10);
    await env.clock.advance(1_500);
    const [current] = await store.claimDue('default', 'w2', env.clock.now(), 1_000, 10);
    if (!stale?.claim || !current?.claim) throw new Error('unreachable');
    env.chain.mine();
    const { monitor, target } = await monitorOf(env);
    await expect(
      env.run(monitor.check(target, current, { claimToken: stale.claim.token })),
    ).rejects.toMatchObject({ code: 'FENCING' });
    expect((await stored(env, sub.operationId)).state).toBe('submitted');
    const moved = await env.run(
      monitor.check(target, current, { claimToken: current.claim.token }),
    );
    expect(moved.state).toBe('included');
  });

  it('judges seqno expiry by the validUntil of the built transaction', async () => {
    const env = await createFakeEnv({ ordering: 'seqno' });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    env.chain.dropFromMempool(sub.attempt?.id ?? '');
    const { monitor, target } = await monitorOf(env);
    const { proofs } = target.pooled.driver;
    const asked: OrderingData[] = [];
    const spying: ProofSource = {
      ...proofs,
      expired: async (ordering) => {
        asked.push(ordering);
        return proofs.expired(ordering);
      },
    };
    const op = await stored(env, sub.operationId);
    await env.run(
      monitor.check(
        {
          ...target,
          pooled: {
            ...target.pooled,
            driver: { ...target.pooled.driver, proofs: spying },
          },
        },
        op,
      ),
    );
    const built = op.attempts[0]?.ordering;
    expect(built).toMatchObject({ kind: 'seqno', seqno: 0n });
    expect(built?.kind === 'seqno' && built.validUntil > 0).toBe(true);
    expect(asked).toEqual([built]);
  });

  it('rebroadcasts the stored bytes of a dropped transaction without signing again', async () => {
    const { signer, calls } = countingSigner();
    const env = await createFakeEnv({ signer });
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.chain.dropFromMempool(ref);
    await env.clock.advance(11_000);
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'dropped',
      evidence: 'observed',
    });
    expect(env.chain.sendCount(ref)).toBe(2);
    expect(env.chain.inMempool(ref)).toBe(true);
    expect(calls()).toBe(1);
    const op = await stored(env, sub.operationId);
    expect(op).toMatchObject({ state: 'submitted', attempts: [expect.anything()] });
  });

  it('waits for the observed finality of a transaction it does not manage', async () => {
    const env = await createFakeEnv();
    const key = secp256k1.utils.randomPrivateKey();
    const from = fakeAddress(secp256k1.getPublicKey(key, true));
    env.chain.fund(from, 100n);
    const id = env.chain.submit(
      signFake(
        {
          chainId: 'fake-local',
          from,
          to: env.stranger(),
          amount: '1',
          fee: '1',
          nonce: '0',
        },
        key,
      ),
    );
    const result = await mineWhile(
      env,
      env.bc.waitForConfirmation(id, { finality: 'final' }),
    );
    expect(result.status).toMatchObject({
      state: 'included',
      evidence: 'observed',
      finality: 'final',
    });
    expect(result.operation).toBeUndefined();
  });
});

describe('broadcast answers never weaken evidence (R25)', () => {
  it.each([[[]], [['insufficient funds']]])(
    'never fails an accepted transfer on a later rejection (earlier refusals: %j)',
    async (refusals: string[]) => {
      const env = await createFakeEnv();
      const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 3n }));
      const ref = sub.attempt?.id ?? '';
      env.chain.dropFromMempool(ref);
      for (const refusal of refusals) {
        env.chain.configureEndpoint('main', { refuseNext: refusal });
        await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
          code: 'INSUFFICIENT_FUNDS',
        });
      }
      env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
      await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
        code: 'TX_REFUSED',
      });
      const op = await stored(env, sub.operationId);
      expect(op).toMatchObject({
        state: 'stalled',
        reservation: { kind: 'nonce', nonce: 0n },
      });
      expect(
        await env.stores.operations.getObservation(op.activeAttemptId ?? ''),
      ).toMatchObject({ state: 'refused', evidence: 'observed' });
      const next = await env.run(
        env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
      );
      expect((await stored(env, next.operation.id)).reservation).toEqual({
        kind: 'nonce',
        nonce: 1n,
      });
      expect((await env.run(env.bc.rebroadcast(sub.operationId))).state).toBe(
        'submitted',
      );
      env.chain.mine();
      expect(env.chain.receipt(ref)?.success).toBe(true);
    },
  );

  it.each([
    ['replaced', 'nonce too low', { replacedBy: 'ab'.repeat(32) }],
    ['replaced', 'invalid signature', { replacedBy: 'ab'.repeat(32) }],
    ['expired', 'transaction expired', {}],
    ['expired', 'invalid signature', {}],
  ] as const)(
    'keeps a %s observation against a later "%s" answer',
    async (state, answer, extra) => {
      const env = await createFakeEnv();
      const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 3n }));
      env.chain.dropFromMempool(sub.attempt?.id ?? '');
      const store = env.stores.operations;
      const attemptId = (await stored(env, sub.operationId)).activeAttemptId ?? '';
      const current = await store.getObservation(attemptId);
      if (!current) throw new Error('unreachable');
      const { version, ...rest } = current;
      await store.putObservation(
        { ...rest, ...extra, state, evidence: 'observed' },
        version,
      );
      env.chain.configureEndpoint('main', { refuseNext: answer });
      expect((await env.run(env.bc.rebroadcast(sub.operationId))).state).toBe(
        'submitted',
      );
      expect(await store.getObservation(attemptId)).toMatchObject({
        ...extra,
        state,
        evidence: 'observed',
      });
      const op = await stored(env, sub.operationId);
      expect(op).toMatchObject({
        state: 'submitted',
        reservation: { kind: 'nonce', nonce: 0n },
      });
      expect(op.error).toBeUndefined();
    },
  );
});

describe('read-only calls never race a broadcast (R26)', () => {
  it('lets a status call race the broadcast without failing the transfer', async () => {
    const env = await createFakeEnv();
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast.bind(driver.broadcaster);
    let raced = 0;
    driver.broadcaster.broadcast = async (signed, options) => {
      raced += 1;
      await env.bc.getTransactionStatus(signed.ref.id);
      return broadcast(signed, options);
    };
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    expect(raced).toBe(1);
    expect(sub.state).toBe('submitted');
    expect(await env.stores.operations.list({ namespace: 'default' })).toHaveLength(1);
    expect(env.chain.sendCount(sub.attempt?.id ?? '')).toBe(1);
    env.chain.mine();
    expect(env.chain.nonce(env.address)).toBe(1n);
  });

  it('surfaces a post-broadcast write it cannot land as ambiguous, naming the operation', async () => {
    // Another writer wins every compare-and-set of the post-broadcast transition.
    class Contended extends MemoryOperationStore {
      override async update(
        namespace: string,
        id: string,
        patch: OperationPatch,
        expectedVersion: number,
        fence?: Fence,
      ): Promise<OperationRecord> {
        if (patch.state === 'submitted') {
          await super.update(namespace, id, { nextCheckAt: 1 }, expectedVersion);
        }
        return super.update(namespace, id, patch, expectedVersion, fence);
      }
    }
    const env = await createFakeEnv({ stores: { operations: new Contended() } });
    const error = await env
      .run(env.bc.transfer({ to: env.stranger(), amount: 5n }, { idempotencyKey: 'c' }))
      .catch((e: unknown) => e);
    const op = await env.stores.operations.getByKey('default', 'c');
    expect(error).toMatchObject({
      code: 'STATE_UNRECORDED',
      ambiguous: true,
      retryable: true,
      context: expect.objectContaining({ operationId: op?.id }),
      details: { causeCode: 'VERSION_CONFLICT' },
    });
    expect(env.chain.inMempool(op?.attempts[0]?.ref.id ?? '')).toBe(true);
  });
});

describe('the all-rejected verdict runs under the address lease (R26.3)', () => {
  it('fails the operation and frees its nonce from a monitor pass', async () => {
    const { env, op } = await rejectedButLive();
    await env.run(env.bc.getTransactionStatus(op.id));
    expect(await stored(env, op.id)).toMatchObject({
      state: 'failed',
      error: { code: 'TX_REJECTED' },
    });
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect((await stored(env, next.operation.id)).reservation).toEqual({
      kind: 'nonce',
      nonce: 0n,
    });
  });

  it('leaves the operation non-terminal when its target cannot be resolved', async () => {
    const { env, op } = await rejectedButLive();
    const internals = containerOf(env.aio);
    const warnings: unknown[] = [];
    const log: Logger = {
      ...noopLogger,
      warn: (_message, fields) => warnings.push(fields),
      child: () => log,
    };
    const monitor = new Monitor({
      engine: internals.engine(),
      stores: env.stores,
      events: internals.runtime.events,
      clock: internals.runtime.clock,
      log,
      namespace: 'default',
      lifecycle: () => withLifecycleDefaults(internals.effective().lifecycle),
      resolveRead: async () => undefined,
      resolveTarget: async () => undefined,
    });
    const { target } = await monitorOf(env);
    const checked = await env.run(monitor.check(target, op));
    expect(checked.state).toBe('signed');
    expect(warnings).toEqual([{ operationId: op.id, code: 'UNKNOWN' }]);
  });
});

describe('monitor: fix round 1 (I2, I3, M4)', () => {
  it('keeps an ambiguous send live through a refusal, so a later rejection is not terminal', async () => {
    const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    const intent = { to: env.stranger(), amount: 3n };
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'p11' })),
    ).rejects.toMatchObject({ ambiguous: true });
    const op = await env.stores.operations.getByKey('default', 'p11');
    if (!op) throw new Error('unreachable');
    env.chain.dropFromMempool(op.attempts[0]?.ref.id ?? '');
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'p11' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    await expect(env.run(env.bc.rebroadcast(op.id))).rejects.toMatchObject({
      code: 'TX_REFUSED',
    });
    expect(await stored(env, op.id)).toMatchObject({
      state: 'stalled',
      error: { code: 'TX_REFUSED' },
      reservation: { kind: 'nonce', nonce: 0n },
    });
  });

  it('ends a watch over an unmanaged transaction that reverted and is final', async () => {
    const env = await createFakeEnv();
    const key = secp256k1.utils.randomPrivateKey();
    const from = fakeAddress(secp256k1.getPublicKey(key, true));
    env.chain.fund(from, 100n);
    const id = env.chain.submit(
      signFake(
        {
          chainId: 'fake-local',
          from,
          to: REVERT_ADDRESS,
          amount: '1',
          fee: '1',
          nonce: '0',
        },
        key,
      ),
    );
    const giveUp = new AbortController();
    void env.clock.sleep(60_000).then(() => giveUp.abort());
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of env.bc.watch(id, { signal: giveUp.signal }))
        seen.push(`${event.status.state}/${event.status.finality}`);
    })();
    await mineWhile(env, consume);
    expect(giveUp.signal.aborted).toBe(false);
    expect(seen[seen.length - 1]).toBe('failed/final');
  });

  /** Counts (and optionally slows) the monitor's reads on a pending transfer. */
  async function slowReads(env: FakeEnv, delayMs: number) {
    const { monitor, target } = await monitorOf(env);
    const { reader, proofs } = target.pooled.driver;
    const calls = { observe: 0, slotConsumed: 0 };
    const pause = () => (delayMs > 0 ? env.clock.sleep(delayMs) : Promise.resolve());
    const slow: ReadTarget = {
      ...target,
      pooled: {
        ...target.pooled,
        driver: {
          ...target.pooled.driver,
          reader: {
            ...reader,
            observe: async (...args) => {
              calls.observe += 1;
              await pause();
              return reader.observe(...args);
            },
          },
          proofs: {
            ...proofs,
            slotConsumed: async (...args) => {
              calls.slotConsumed += 1;
              await pause();
              return proofs.slotConsumed(...args);
            },
          },
        },
      },
    };
    return { monitor, target: slow, calls };
  }

  it('checks the timeout before each pass', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    const { monitor, target, calls } = await slowReads(env, 0);
    await expect(
      env.run(
        monitor.waitFor(target, sub.operationId, {
          timeoutMs: 3_000,
          pollIntervalMs: 1_000,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls.observe).toBe(3);
  });

  it('stops a slow pass at the deadline after at most one in-flight read', async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.dropFromMempool(sub.attempt?.id ?? '');
    const { monitor, target, calls } = await slowReads(env, 2_000);
    const started = env.clock.now();
    let settledAt = 0;
    const waiting = monitor
      .waitFor(target, sub.operationId, { timeoutMs: 3_000 })
      .finally(() => {
        settledAt = env.clock.now();
      });
    await expect(env.run(waiting)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(settledAt - started).toBeLessThanOrEqual(3_000 + 2_000);
    expect(calls.slotConsumed).toBe(1);
  });

  it("aborts a pass with the caller's signal after at most one in-flight read", async () => {
    const env = await createFakeEnv();
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
    env.chain.dropFromMempool(sub.attempt?.id ?? '');
    const { monitor, target, calls } = await slowReads(env, 2_000);
    const ctl = new AbortController();
    void env.clock.sleep(1_000).then(() => ctl.abort(new Error('stop')));
    const started = env.clock.now();
    let settledAt = 0;
    const waiting = monitor
      .waitFor(target, sub.operationId, { signal: ctl.signal })
      .finally(() => {
        settledAt = env.clock.now();
      });
    await expect(env.run(waiting)).rejects.toThrow('stop');
    expect(settledAt - started).toBeLessThanOrEqual(2_000);
    expect(calls.slotConsumed).toBe(0);
  });
});

describe('monitor: fix round 2', () => {
  it('keeps an operation a read-only pass moved out of signed claimable', async () => {
    const faulty = new FaultyOperationStore(new MemoryOperationStore());
    const first = await createFakeEnv({ stores: { operations: faulty } });
    faulty.crashOn({
      method: 'update',
      timing: 'before',
      when: (args) => (args[2] as OperationPatch | undefined)?.state === 'submitted',
    });
    await expect(
      first.run(
        first.bc.transfer(
          { to: first.stranger(), amount: 3n },
          { idempotencyKey: 'sch' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'STATE_UNRECORDED' });
    const env = await first.restart({ killPrevious: true });
    const signed = await env.stores.operations.getByKey('default', 'sch');
    if (!signed) throw new Error('unreachable');
    expect(signed.state).toBe('signed');
    await env.run(env.bc.getTransactionStatus(signed.id));
    const moved = await stored(env, signed.id);
    expect(moved.state).toBe('submitted');
    expect(moved.nextCheckAt).toBeDefined();
    const due = await env.stores.operations.claimDue(
      'default',
      'worker',
      env.clock.now(),
      1_000,
      10,
    );
    expect(due.map((op) => op.id)).toEqual([signed.id]);
  });
});

describe('monitor: the all-rejected verdict from read-only passes (fix round 2)', () => {
  it("bounds the lease wait by the caller's deadline and signal", async () => {
    const { env, op } = await rejectedButLive();
    await holdLease(env);
    let started = env.clock.now();
    let settledAt = 0;
    const timed = env.bc.waitForConfirmation(op.id, { timeoutMs: 2_000 }).finally(() => {
      settledAt = env.clock.now();
    });
    await expect(env.run(timed)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(settledAt - started).toBeLessThanOrEqual(2_100);
    const ctl = new AbortController();
    void env.clock.sleep(500).then(() => ctl.abort(new Error('stop')));
    started = env.clock.now();
    const aborted = env.bc
      .waitForConfirmation(op.id, { signal: ctl.signal })
      .finally(() => {
        settledAt = env.clock.now();
      });
    await expect(env.run(aborted)).rejects.toThrow('stop');
    expect(settledAt - started).toBeLessThanOrEqual(600);
    expect((await stored(env, op.id)).state).toBe('signed');
  });

  it('leaves the operation non-terminal and logs the code while the lease stays busy', async () => {
    const { log, warnings } = capturingLogger();
    const { env, op } = await rejectedButLive({ aio: { logger: log } });
    await holdLease(env);
    // Fix round 3: a call without a signal tries the lease once instead of waiting it out.
    const started = env.clock.now();
    expect(await env.run(env.bc.getTransactionStatus(op.id))).toMatchObject({
      state: 'rejected',
    });
    expect(env.clock.now() - started).toBeLessThanOrEqual(200);
    expect((await stored(env, op.id)).state).toBe('signed');
    expect(warnings).toContainEqual({
      message: expect.any(String),
      fields: { operationId: op.id, code: 'SEQUENCE_BUSY' },
    });
    const watching = (async () => {
      for await (const event of env.bc.watch(op.id)) return event.status.state;
      return undefined;
    })();
    const watchStarted = env.clock.now();
    expect(await env.run(watching)).toBe('rejected');
    expect(env.clock.now() - watchStarted).toBeLessThanOrEqual(200);
  });

  it('treats a wallet re-pointed to another key as an unresolvable target', async () => {
    const { log, warnings } = capturingLogger();
    const { env, op } = await rejectedButLive({ aio: { logger: log } });
    const repointed = env.aio.scope({
      signers: { hot: localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer },
    });
    const bc = repointed.blockchain({ chain: env.chainId });
    expect(await env.run(bc.getTransactionStatus(op.id))).toMatchObject({
      state: 'rejected',
    });
    expect((await stored(env, op.id)).state).toBe('signed');
    expect(warnings).toContainEqual({
      message: expect.any(String),
      fields: { operationId: op.id, code: 'INVALID_INTENT' },
    });
  });
});

describe('monitor: fix round 3', () => {
  it('records an ambiguous broadcast as possibly live even when a claim races its update', async () => {
    const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
    const { driver } = await internalsOf(env.bc).pooled();
    const broadcast = driver.broadcaster.broadcast.bind(driver.broadcaster);
    let claimed = 0;
    driver.broadcaster.broadcast = async (signed, options) => {
      if (claimed === 0) {
        claimed = (
          await env.stores.operations.claimDue('default', 'w', env.clock.now(), 1_000, 10)
        ).length;
      }
      return broadcast(signed, options);
    };
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    const intent = { to: env.stranger(), amount: 3n };
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'race' })),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(claimed).toBe(1);
    const op = await env.stores.operations.getByKey('default', 'race');
    if (!op) throw new Error('unreachable');
    expect(op).toMatchObject({ state: 'submitted', ambiguous: true });
    env.chain.dropFromMempool(op.attempts[0]?.ref.id ?? '');
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'race' })),
    ).rejects.toMatchObject({ code: 'TX_REFUSED' });
    expect(await stored(env, op.id)).toMatchObject({
      state: 'stalled',
      reservation: { kind: 'nonce', nonce: 0n },
    });
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect((await stored(env, next.operation.id)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
  });
});

describe('monitor: fix round 4', () => {
  it('revives a refused attempt as possibly live after an ambiguous resend (R25)', async () => {
    const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
    const intent = { to: env.stranger(), amount: 3n };
    env.chain.configureEndpoint('main', { refuseNext: 'insufficient funds' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'revive' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const op = await env.stores.operations.getByKey('default', 'revive');
    if (!op) throw new Error('unreachable');
    expect(
      await env.stores.operations.getObservation(op.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'refused' });
    // The node admits the bytes, then the send fails: the outcome is ambiguous.
    env.chain.configureEndpoint('main', { acceptThenFail: true });
    await expect(env.run(env.bc.rebroadcast(op.id))).rejects.toMatchObject({
      ambiguous: true,
    });
    env.chain.dropFromMempool(op.attempts[0]?.ref.id ?? '');
    env.chain.configureEndpoint('main', { refuseNext: 'invalid signature' });
    await expect(
      env.run(env.bc.transfer(intent, { idempotencyKey: 'revive' })),
    ).rejects.toMatchObject({ code: 'TX_REFUSED' });
    expect(await stored(env, op.id)).toMatchObject({
      state: 'stalled',
      error: { code: 'TX_REFUSED' },
      reservation: { kind: 'nonce', nonce: 0n },
    });
    const next = await env.run(
      env.bc.prepareTransfer({ to: env.stranger(), amount: 1n }),
    );
    expect((await stored(env, next.operation.id)).reservation).toEqual({
      kind: 'nonce',
      nonce: 1n,
    });
  });

  it('tries the lease once on an unfenced pass even with a signal', async () => {
    const { log, warnings } = capturingLogger();
    const { env, op } = await rejectedButLive({ aio: { logger: log } });
    await holdLease(env);
    const ctl = new AbortController();
    const watching = (async () => {
      for await (const event of env.bc.watch(op.id, { signal: ctl.signal }))
        return event.status.state;
      return undefined;
    })();
    const started = env.clock.now();
    expect(await env.run(watching)).toBe('rejected');
    expect(env.clock.now() - started).toBeLessThanOrEqual(200);
    expect((await stored(env, op.id)).state).toBe('signed');
    expect(warnings).toContainEqual({
      message: expect.any(String),
      fields: { operationId: op.id, code: 'SEQUENCE_BUSY' },
    });
    ctl.abort();
  });
});
