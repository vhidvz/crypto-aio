import { Interface, Wallet } from 'ethers';
import type {
  AioEvent,
  ChainInfo,
  OperationPatch,
  ScanEvent,
  Signer,
} from '../../../src';
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { evmChainPlugin } from '../../../src/adapters/evm/plugin';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { native } from '../../../src/native';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner, createEvmEnv } from './support/env';
import { LIBRARIES } from './support/harness';
import type { ScriptedEvmNode } from './support/node';
import { KEY, RECIPIENT } from './support/vectors';

const TOKEN = '0x00000000000000000000000000000000000070Ce';
const JUNK = '0x0000000000000000000000000000000000000Bad';
const FALSE_TOKEN = '0x000000000000000000000000000000000000fA15';
const GWEI = 1_000_000_000n;

/** A legacy-fee chain with 3-confirmation finality, served through evmChainPlugin. */
const legacyChain: ChainInfo = {
  ...(EVM_CHAINS[1] as ChainInfo),
  id: 'legacychain',
  defaultNetwork: 'main',
  networks: {
    main: {
      ...(EVM_CHAINS[1]?.networks.testnet as ChainInfo['networks'][string]),
      id: 'main',
      identity: '4242',
      finality: { kind: 'confirmations', confirmations: 3 },
      capabilities: { remove: ['fee-market-1559', 'finality-tag'] },
    },
  },
};

describe.each(LIBRARIES)('EVM end to end (%s)', (library) => {
  it('runs a native transfer to proven finality on the finalized tag', async () => {
    // The finalized tag trails the head by 6 blocks, so a confirmation rule would end early.
    const env = await createEvmEnv({ library, node: { finalizedDepth: 6 } });
    // The `finalized` tag reads: the node's finalized height when each was served.
    const tagReads: bigint[] = [];
    env.node.intercept = (_endpoint, method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized')
        tagReads.push(env.node.finalized);
      return undefined;
    };
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: '0.001' }, { idempotencyKey: 'n1' }),
    );
    expect(sub).toMatchObject({
      state: 'submitted',
      attempt: { idKind: 'tx-hash', canonical: true },
    });
    expect(env.node.inMempool(sub.attempt?.id ?? '')).toBe(true);
    const final = await env.mineWhile(sub.wait({ finality: 'final' }));
    // R75: final once the finalized tag reached the transaction's block, and not before.
    const block = env.node.receipt(sub.attempt?.id ?? '')?.blockNumber ?? 0n;
    expect(tagReads.at(-1)).toBeGreaterThanOrEqual(block);
    expect(env.node.head - block).toBeGreaterThanOrEqual(6n);
    expect(final.status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    expect(env.node.balance(RECIPIENT)).toBe(10n ** 15n);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers[0]).toMatchObject({
      to: { canonical: RECIPIENT },
      amount: { base: 10n ** 15n },
    });
    expect(tx?.decoding).toBe('complete');
  });

  it('pays legacy fees and waits for confirmation finality', async () => {
    const env = await createEvmEnv({
      library,
      chain: 'legacychain',
      network: 'main',
      // A tag rule would wait 20 blocks: only the confirmation rule ends within 10.
      node: { finalizedDepth: 20 },
      plugins: [evmChainPlugin({ name: 'legacy', chains: [legacyChain] })],
    });
    const fee = await env.run(env.bc.estimateFee({ to: RECIPIENT, amount: 1n }));
    expect(fee).toMatchObject({
      kind: 'evm-legacy',
      bound: 'upper',
      details: { gasPrice: 5_500_000_000n },
    });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 1n }));
    env.node.mine();
    await env.run(sub.wait({ confirmations: 1 }));
    const final = await env.mineWhile(sub.wait({ finality: 'final' }), 10);
    // R75: final once the quorum holds the block that gives it 3 confirmations (h + 2).
    const block = env.node.receipt(sub.attempt?.id ?? '')?.blockNumber ?? 0n;
    expect(final.status.confirmations).toBeGreaterThanOrEqual(3);
    expect(env.node.head - block).toBeGreaterThanOrEqual(2n);
  });

  it('lands five concurrent transfers from one address on consecutive nonces', async () => {
    const env = await createEvmEnv({ library });
    const subs = await env.run(
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          env.bc.transfer(
            { to: RECIPIENT, amount: BigInt(i + 1) },
            { idempotencyKey: `c${i}` },
          ),
        ),
      ),
      10,
    );
    const nonces = await Promise.all(
      subs.map(
        async (s) =>
          (await env.stores.operations.get('default', s.operationId))?.reservation,
      ),
    );
    expect(nonces.map((r) => (r?.kind === 'nonce' ? r.nonce : -1n)).sort()).toEqual([
      0n,
      1n,
      2n,
      3n,
      4n,
    ]);
    const finals = await env.mineWhile(
      Promise.all(subs.map((s) => s.wait({ finality: 'final' }))),
    );
    expect(finals.every((f) => f.status.state === 'final')).toBe(true);
    expect(env.node.nonce(env.address)).toBe(5n);
    expect(env.node.balance(RECIPIENT)).toBe(15n);
  });

  it("replaces on the same nonce and recovers from the node's underpriced answer", async () => {
    // The node bumps by 50% while the registry says 10%: the node gets the last word.
    const env = await createEvmEnv({ library, node: { minBumpPercent: 50 } });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 7n, fee: 'slow' }),
    );
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'normal' })),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('submitted');
    expect(op?.activeAttemptId).toBe(op?.attempts[0]?.id);
    const replaced = await env.run(
      env.bc.replace(sub.operationId, {
        fee: { maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 4n * GWEI },
      }),
    );
    expect(replaced.attempts.map((a) => a.purpose)).toEqual([
      'original',
      'replacement',
      'replacement',
    ]);
    expect(env.node.inMempool(sub.attempt?.id ?? '')).toBe(false);
    const final = await env.mineWhile(replaced.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(7n);
  });

  it('cancels with a zero-value self-transfer on the same nonce', async () => {
    const env = await createEvmEnv({ library });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 7n, fee: 'slow' }),
    );
    const cancelled = await env.run(env.bc.cancel(sub.operationId));
    expect(cancelled.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
    // The cancel as broadcast: zero value, to the sender itself.
    const sent = env.node.answer('eth_getTransactionByHash', [
      cancelled.attempts[1]?.ref.id,
    ]) as { readonly to: string; readonly value: string } | null;
    expect([sent?.to.toLowerCase(), sent?.value]).toEqual([
      env.address.toLowerCase(),
      '0x0',
    ]);
    const final = await env.mineWhile(cancelled.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
    expect(env.node.balance(RECIPIENT)).toBe(0n);
  });

  it('treats a late cancel\'s "nonce too low" as a lost race and a resend as already known', async () => {
    const env = await createEvmEnv({ library });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 7n }));
    expect((await env.run(env.bc.rebroadcast(sub.operationId))).state).toBe('submitted');
    expect(env.node.sendCount(sub.attempt?.id ?? '')).toBe(2);
    env.node.mine();
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'NONCE_CONFLICT',
    });
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation?.outcome).toBe('executed');
  });

  it('never ends a transfer that a lone endpoint calls invalid, then relays (lesson 21)', async () => {
    const env = await createEvmEnv({ library });
    // A lying endpoint keeps our valid bytes, claims a bad signature, and relays them later.
    let held: string | undefined;
    env.node.intercept = (_endpoint, method, params) => {
      if (method !== 'eth_sendRawTransaction' || held !== undefined) return undefined;
      held = params[0] as string;
      return { error: { code: -32000, message: 'invalid sender' } };
    };
    const error = await env
      .run(env.bc.transfer({ to: RECIPIENT, amount: 7n }, { idempotencyKey: 'liar' }))
      .catch((e: unknown) => e);
    // Before lesson 21 this was TX_REJECTED: the Operation failed and freed its nonce, so a
    // later relay plus a retry under a new key paid twice.
    expect(error).toMatchObject({ code: 'TX_REFUSED' });
    const operationId = String(
      (error as { context: { operationId?: string } }).context.operationId,
    );
    expect((await env.stores.operations.get('default', operationId))?.state).toBe(
      'stalled',
    );
    env.node.submit(held as string);
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(7n);
  });

  it('survives a reorg that drops the transaction, with the orphan check read from both endpoints', async () => {
    const env = await createEvmEnv({ library, endpoints: ['a', 'b'] });
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const disagreements: AioEvent[] = [];
    env.aio.on('provider.inconsistent', (e) => disagreements.push(e));
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    env.node.mine();
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const orphan = env.node.receipt(ref);
    const height = `0x${(orphan?.blockNumber ?? 0n).toString(16)}`;
    const stale = env.node.answer('eth_getBlockByNumber', [height, false]);
    env.node.reorg(1, [ref]);
    env.node.served.length = 0;
    expect(env.node.inMempool(ref)).toBe(false);
    // The orphan check reads the block at the recorded height, a fixed height (lesson 17),
    // from every endpoint of the proof quorum. While b still serves the orphaned block, the
    // quorum disagrees, which decides nothing (R33, R77): no reorg and no resend.
    const checks: { endpoint: string; block: 'orphaned' | 'new'; decided: boolean }[] =
      [];
    let bLags = true;
    env.node.intercept = (endpoint, method, params) => {
      if (method !== 'eth_getBlockByNumber' || params[0] !== height) return undefined;
      const lagging = bLags && endpoint === 'b';
      checks.push({
        endpoint,
        block: lagging ? 'orphaned' : 'new',
        decided: reorgs.length > 0,
      });
      return lagging ? { result: stale } : undefined;
    };
    const waiting = env.bc.waitForConfirmation(sub.operationId, { finality: 'final' });
    waiting.catch(() => undefined);
    for (let i = 0; i < 10; i++) {
      env.node.mine();
      await env.clock.advance(1_000);
    }
    expect(new Set(checks.map((c) => c.endpoint))).toEqual(new Set(['a', 'b']));
    expect([reorgs.length, env.node.sendCount(ref)]).toEqual([0, 1]);
    // Only a quorum (proof) read compares endpoints, so only it reports a disagreement.
    expect(disagreements.length).toBeGreaterThan(0);
    for (const event of disagreements) {
      expect(event).toMatchObject({
        method: 'eth_getBlockByNumber',
        endpointIds: ['node/a', 'node/b'],
      });
    }
    bLags = false;
    const final = await env.mineWhile(waiting);
    expect(final.operation?.state).toBe('final');
    expect(
      new Set(
        env.node.served
          .filter((s) => s.method === 'eth_getBlockByNumber')
          .map((s) => s.endpoint),
      ),
    ).toEqual(new Set(['a', 'b']));
    // Decided only once both endpoints served the new block at that height.
    expect(checks.filter((c) => !c.decided).slice(-2)).toEqual([
      { endpoint: 'a', block: 'new', decided: false },
      { endpoint: 'b', block: 'new', decided: false },
    ]);
    expect(reorgs[0]).toMatchObject({
      operationId: sub.operationId,
      previousBlockHash: orphan?.blockHash,
    });
    expect(env.node.block(orphan?.blockNumber ?? 0n)?.hash).not.toBe(orphan?.blockHash);
    expect(env.node.sendCount(ref)).toBeGreaterThanOrEqual(2);
    expect(env.node.balance(RECIPIENT)).toBe(5n);
  });

  it('keeps waiting while the node holds no finalized state for an absent transaction (R85)', async () => {
    const env = await createEvmEnv({ library });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 5n }));
    const ref = sub.attempt?.id ?? '';
    // The node lost sight of the transaction and holds no state below its head, so the
    // monitor's proof that the slot is not consumed at finality cannot be read.
    let refused = 0;
    env.node.intercept = (_endpoint, method, params) => {
      if (method === 'eth_getTransactionByHash' && params[0] === ref) {
        return { result: null };
      }
      if (
        method === 'eth_getTransactionCount' &&
        params[1] !== 'latest' &&
        params[1] !== 'pending'
      ) {
        refused += 1;
        return { error: { code: -32000, message: 'missing trie node' } };
      }
      return undefined;
    };
    const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(status).toMatchObject({ evidence: 'observed' });
    expect(refused).toBe(1);
    let settled = false;
    const waiting = env.bc.waitForConfirmation(sub.operationId, { finality: 'final' });
    waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 20; i++) await env.clock.advance(1_000);
    expect([settled, refused > 1]).toEqual([false, true]);
    env.node.intercept = undefined;
    const final = await env.mineWhile(waiting);
    expect(final.operation?.state).toBe('final');
    expect(env.node.balance(RECIPIENT)).toBe(5n);
  });

  /** R88: both endpoints' transaction index lost `hash` (geth past its history window). */
  const unindexed = (env: { readonly node: ScriptedEvmNode }, hash: string) => {
    env.node.intercept = (_endpoint, method, params) =>
      (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') &&
      params[0] === hash
        ? { result: null }
        : undefined;
  };

  it('proves a final transfer the index lost executed, never replaced (R88)', async () => {
    // The final review's C1: no pass saw the transfer land before the endpoints' index
    // dropped it (an outage, a restored store, or no monitor running).
    const env = await createEvmEnv({ library, endpoints: ['a', 'b'] });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 3n }));
    const ref = sub.attempt?.id ?? '';
    env.node.mine(10);
    expect(env.node.balance(RECIPIENT)).toBe(3n);
    expect(env.node.receipt(ref)?.status).toBe(1);
    unindexed(env, ref);
    const final = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(
      await env.stores.operations.getObservation(op?.activeAttemptId ?? ''),
    ).toMatchObject({
      state: 'final',
      evidence: 'proven',
      blockHash: env.node.receipt(ref)?.blockHash,
    });
  });

  it('still proves a transfer replaced from outside the library replaced (R88)', async () => {
    const env = await createEvmEnv({ library, endpoints: ['a', 'b'] });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 3n, fee: 'slow' }),
    );
    // The same key signs another transaction for the same nonce elsewhere, paying more.
    const raw = await new Wallet(`0x${KEY}`).signTransaction({
      chainId: env.node.options.chainId,
      nonce: 0,
      to: env.address,
      value: 0n,
      gasLimit: 21_000n,
      type: 2,
      maxFeePerGas: 100n * GWEI,
      maxPriorityFeePerGas: 50n * GWEI,
    });
    const external = env.node.submit(raw);
    env.node.mine();
    expect(env.node.receipt(external)?.status).toBe(1);
    unindexed(env, external);
    await expect(env.mineWhile(sub.wait({ finality: 'final' }))).rejects.toMatchObject({
      code: 'TX_REPLACED',
    });
    const op = await env.stores.operations.get('default', sub.operationId);
    expect(op?.state).toBe('failed');
    expect(
      await env.stores.operations.getObservation(op?.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'replaced', evidence: 'proven' });
    expect(env.node.balance(RECIPIENT)).toBe(0n);
  });

  describe('crash and recovery', () => {
    async function crashEnv() {
      const { signer, calls } = countingSigner();
      const faulty = new FaultyOperationStore(new MemoryOperationStore());
      const env = await createEvmEnv({ library, signer, stores: { operations: faulty } });
      return { env, faulty, calls };
    }
    const patchState = (state: string) => (args: readonly unknown[]) =>
      (args[2] as OperationPatch | undefined)?.state === state;

    it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      // Before the kill: a thrown store write leaves no timer armed (the fence, not this
      // pin, is what makes the restart safe).
      expect(env.clock.pending).toBe(0);
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.sendCount(ref)]).toEqual(['signed', 0]);
      const restarted = await env.restart({ killPrevious: true });
      // The crashed process is dead: nothing on its handle settles any more.
      let oldSettled = false;
      void env.bc.getBlockHeight().then(
        () => (oldSettled = true),
        () => (oldSettled = true),
      );
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(3n);
      expect(oldSettled).toBe(false);
    });

    it('recovers a broadcast that was never recorded: the node answers "already known"', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({
        method: 'update',
        timing: 'before',
        when: patchState('submitted'),
      });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      // The crash boundary: signed and sent, but `submitted` never written. `pending` is
      // taken before the kill: a thrown store write leaves no timer armed (the fence, not
      // this pin, is what makes the restart safe).
      expect([stored?.state, env.node.inMempool(ref), env.clock.pending]).toEqual([
        'signed',
        true,
        0,
      ]);
      const restarted = await env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      expect(env.node.sendCount(ref)).toBe(2); // the resend was answered "already known"
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' }),
      );
      // Recovered, not rebuilt: the same Attempt, signed once.
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
    });

    it('takes over the address lease of a process killed mid-sign, then signs once more (R91 M6)', async () => {
      const counting = countingSigner();
      const signedAt: number[] = [];
      const signer: Signer = {
        ...counting.signer,
        sign: (requests, ctx) => {
          signedAt.push(env.clock.now());
          // The first process dies while its signer works: that call never returns.
          return signedAt.length === 1
            ? new Promise<never>(() => undefined)
            : counting.signer.sign(requests, ctx);
        },
      };
      const env = await createEvmEnv({ library, signer });
      const leaseMs = 30_000; // createEvmEnv's lifecycle
      const intent = { to: RECIPIENT, amount: 3n };
      const startedAt = env.clock.now();
      let firstSettled = false;
      void env.bc.transfer(intent, { idempotencyKey: 'k' }).then(
        () => (firstSettled = true),
        () => (firstSettled = true),
      );
      for (let i = 0; i < 1_000 && signedAt.length === 0; i++) await env.clock.advance(1);
      expect(signedAt).toHaveLength(1);
      const killedAt = env.clock.now();
      // Killed while signing: no store write or timer of the dead process settles, so its
      // address lease is never released, only left to expire.
      const restarted = await env.restart({ killPrevious: true });
      const retried = restarted.bc.transfer(intent, { idempotencyKey: 'k' });
      await env.clock.advance(leaseMs / 2);
      expect(signedAt).toHaveLength(1);
      const sub = await env.run(retried);
      expect(sub.state).toBe('submitted');
      expect(signedAt).toHaveLength(2);
      expect((signedAt[1] as number) - startedAt).toBeGreaterThanOrEqual(leaseMs);
      expect((signedAt[1] as number) - killedAt).toBeLessThanOrEqual(leaseMs + 5_000);
      const final = await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect(final.operation?.attempts).toHaveLength(1);
      expect([signedAt.length, counting.calls(), firstSettled]).toEqual([2, 1, false]);
      expect(env.node.balance(RECIPIENT)).toBe(3n);
    });

    it('resumes a prepared transfer and keeps its nonce for it', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'update', timing: 'after', when: patchState('prepared') });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      // Before the kill: a thrown store write leaves no timer armed (the fence, not this
      // pin, is what makes the restart safe).
      expect(env.clock.pending).toBe(0);
      expect((await env.stores.operations.getByKey('default', 'k'))?.state).toBe(
        'prepared',
      );
      const restarted = await env.restart({ killPrevious: true });
      const other = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 1n }, { idempotencyKey: 'other' }),
      );
      expect(
        (await env.stores.operations.get('default', other.operationId))?.reservation,
      ).toEqual({ kind: 'nonce', nonce: 1n });
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['submitted', 2]);
      env.node.mine();
      expect(env.node.nonce(env.address)).toBe(2n);
    });
  });

  it('transfers an ERC-20 token by contract, with decimals read from the chain', async () => {
    const { signer, calls } = countingSigner();
    const env = await createEvmEnv({ library, signer });
    env.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    env.node.mintToken(TOKEN, env.address, 5_000_000n);
    const asset = { standard: 'erc20', contract: TOKEN.toLowerCase() };
    expect((await env.run(env.bc.getBalance(env.address, asset))).amount.format()).toBe(
      '5 TKN',
    );
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: '1.5', asset }));
    await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(env.node.tokenBalance(TOKEN, RECIPIENT)).toBe(1_500_000n);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers).toEqual([
      expect.objectContaining({
        id: `${sub.attempt?.id}:log:0`,
        source: 'token-event',
        asset: expect.objectContaining({ id: `ethereum:sepolia/erc20:${TOKEN}` }),
        amount: expect.objectContaining({ base: 1_500_000n }),
      }),
    ]);
    expect(tx?.decoding).toBe('partial');
    // Review Focus 2: a shortfall fails before signing, with both amounts in base units,
    // not as the reverting gas estimate's opaque RPC error.
    await expect(
      env.run(env.bc.transfer({ to: RECIPIENT, amount: '9', asset })),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '9000000', available: '3500000' },
    });
    expect([calls(), env.node.nonce(env.address)]).toEqual([1, 1n]);
  });

  it('proves a token transfer that returned false failed, while the chain reports success (R50, R68)', async () => {
    const env = await createEvmEnv({ library });
    env.node.deployToken(FALSE_TOKEN, { symbol: 'FLS', decimals: 6, returnsFalse: true });
    env.node.mintToken(FALSE_TOKEN, env.address, 5_000_000n);
    const asset = { standard: 'erc20', contract: FALSE_TOKEN };
    // Each transfer fits the balance when built; the second finds too little when it runs,
    // and this token then returns false: status 1, nothing moved, no Transfer log.
    const first = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: '3', asset }, { idempotencyKey: 'f1' }),
    );
    const second = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: '3', asset }, { idempotencyKey: 'f2' }),
    );
    const firstFinal = await env.mineWhile(first.wait({ finality: 'final' }));
    expect(firstFinal.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    const ref = second.attempt?.id ?? '';
    expect(env.node.receipt(ref)?.status).toBe(1);
    await expect(env.mineWhile(second.wait({ finality: 'final' }))).rejects.toMatchObject(
      {
        code: 'TX_REVERTED',
        retryable: false,
      },
    );
    const op = await env.stores.operations.get('default', second.operationId);
    expect(op?.state).toBe('failed');
    expect(
      await env.stores.operations.getObservation(op?.activeAttemptId ?? ''),
    ).toMatchObject({ state: 'failed', evidence: 'proven' });
    expect(env.node.tokenBalance(FALSE_TOKEN, RECIPIENT)).toBe(3_000_000n);
    // The chain's view (R68): the call succeeded and moved nothing.
    const tx = await env.run(env.bc.getTransaction(ref));
    expect([tx?.transfers, tx?.decoding]).toEqual([[], 'partial']);
  });

  it('scans final blocks for deposits, marking a junk token unresolved instead of failing (R35)', async () => {
    const env = await createEvmEnv({ library });
    env.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    env.node.deployToken(JUNK, { symbol: 'JUNK' });
    env.node.mintToken(TOKEN, env.address, 10n);
    env.node.mintToken(JUNK, env.address, 10n);
    const deposits = [
      env.bc.transfer({ to: RECIPIENT, amount: 4n }, { idempotencyKey: 'd1' }),
      env.bc.transfer(
        { to: RECIPIENT, amount: 2n, asset: { standard: 'erc20', contract: TOKEN } },
        { idempotencyKey: 'd2' },
      ),
    ];
    const subs = [];
    for (const deposit of deposits) subs.push(await env.run(deposit));
    await env.mineWhile(Promise.all(subs.map((s) => s.wait({ finality: 'final' }))));
    // A junk token cannot be sent through the library (its metadata never resolves), so
    // another wallet moves it, straight through the node.
    const junk = await new Wallet(`0x${KEY}`).signTransaction({
      type: 2,
      chainId: 11155111n,
      nonce: 2,
      to: JUNK,
      value: 0n,
      gasLimit: 60_000n,
      maxFeePerGas: 3n * GWEI,
      maxPriorityFeePerGas: GWEI,
      data: new Interface(['function transfer(address,uint256)']).encodeFunctionData(
        'transfer',
        [RECIPIENT, 5n],
      ),
    });
    env.node.submit(junk);
    env.node.mine(3);
    // A deposit in a later block: the scan must move past the junk token's block.
    const after = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 1n }, { idempotencyKey: 'd3' }),
    );
    env.node.mine();
    const scanner = env.bc
      .scanner({
        cursorKey: 'deposits',
        from: 0n,
        mode: 'final',
        filter: { addresses: [RECIPIENT] },
      })
      [Symbol.asyncIterator]();
    const seen: ScanEvent[] = [];
    for (
      let i = 0;
      i < 500 &&
      seen.flatMap((e) => (e.type === 'block' ? e.transactions : [])).length < 4;
      i++
    ) {
      const next = await env.mineWhile(scanner.next());
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
      ['0.000000000000000004 ETH'],
      ['0.000002 TKN'],
      ['ASSET_RESOLUTION'],
      ['0.000000000000000001 ETH'],
    ]);
    expect(txs[2]).toMatchObject({
      decoding: 'partial',
      transfers: [
        { unresolved: { asset: { standard: 'erc20', contract: JUNK }, amount: 5n } },
      ],
    });
    expect(txs[3]?.id).toBe(after.attempt?.id);
  });

  it('hands the handle its own native SDK client', async () => {
    const env = await createEvmEnv({ library });
    const client = await env.run(native(env.bc, library as never));
    expect(await env.run(native(env.bc, library as never))).toBe(client);
    await env.aio.close();
  });
});
