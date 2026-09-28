import type { OperationPatch, ScanEvent } from '../../../src';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { native } from '../../../src/native';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import type { FakeRequest } from '../../../src/testing/fake-fetch';
import { encodeTransfer } from '../../../src/adapters/tron/abi';
import { toBase58Address, toHexAddress } from '../../../src/adapters/tron/address';
import { TAPOS_WINDOW } from '../../../src/adapters/tron/network';
import { countingSigner, createTronEnv } from './support/env';
import { FEE_COLLECTOR } from './support/node';
import { decodeRawData, decodeTransaction } from './support/protobuf';
import { signedTransaction } from './support/signing';
import { KEY_HEX, RECIPIENT, USDT } from './support/vectors';

const TOKEN = { standard: 'trc20', contract: USDT } as const;
const JUNK = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

type TronEnv = ReturnType<typeof createTronEnv>;

/** Every java-tron answer the classifier reads as a definitive `rejected` (Task 5). */
const CLAIMS = [
  ['SIGERROR', 'Validate signature error: Signature size is 64'],
  ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : No contract!'],
  [
    'CONTRACT_VALIDATE_ERROR',
    'Contract validate error : Cannot transfer TRX to yourself.',
  ],
  ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : Amount must be greater than 0.'],
  [
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction, TxId ${'ab'.repeat(32)}, the size is 600000 bytes, maxTxSize 512000`,
  ],
  [
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction with result, TxId ${'ab'.repeat(32)}, the size is 600000 bytes, maxTxSize 512000`,
  ],
] as const;

// `update(namespace, id, patch, …)`: the patch is the third argument.
const patchState = (state: string) => (args: readonly unknown[]) =>
  (args[2] as OperationPatch | undefined)?.state === state;

jest.setTimeout(60_000);

// The container builds its own transports, whose backoff jitter then falls back to
// `Math.random`: pin it (lesson 1, R46). Their ids cannot be fixed through `CryptoAio`.
beforeAll(() => {
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterAll(() => {
  jest.restoreAllMocks();
});

function withToken(env: TronEnv, holder = env.address, amount = 1_000_000_000n) {
  env.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
  env.node.mintToken(USDT, holder, amount);
}

/** Mines `blocks` blocks, one per 3 fake seconds. */
async function mine(env: TronEnv, blocks: number): Promise<void> {
  for (let i = 0; i < blocks; i++) {
    await env.clock.advance(3_000);
    env.node.mine();
  }
}

/** An Operation's stored Attempt and its signed raw data, read with the test's own decoder. */
async function storedAttempt(env: TronEnv, operationId: string, index = 0) {
  const op = await env.stores.operations.get('default', operationId);
  const attempt = op?.attempts[index];
  if (!attempt) throw new Error('no such attempt');
  return { attempt, signed: decodeRawData(decodeTransaction(attempt.raw.data).rawHex) };
}

/** The height of the block signed bytes reference (TaPoS: the id's bytes 6..16). */
function referenced(
  env: TronEnv,
  raw: { readonly refBlockBytes: string; readonly refBlockHash: string },
): number {
  for (let n = env.node.head; n >= 0; n--) {
    const id = env.node.block(n)?.id ?? '';
    if (id.slice(12, 16) === raw.refBlockBytes && id.slice(16, 32) === raw.refBlockHash) {
      return n;
    }
  }
  throw new Error('no reference block');
}

describe('Tron end to end', () => {
  it('runs a TRX transfer to proven finality at the solidified block', async () => {
    const env = createTronEnv();
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: '1.5' }, { idempotencyKey: 't1' }),
    );
    expect(sub).toMatchObject({
      state: 'submitted',
      attempt: { idKind: 'tx-hash', canonical: true },
    });
    expect(env.node.inPool(sub.attempt?.id ?? '')).toBe(true);
    const final = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(final.status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    expect(env.node.balance(RECIPIENT)).toBe(1_500_000n);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers[0]).toMatchObject({
      to: { canonical: RECIPIENT },
      amount: { base: 1_500_000n },
    });
    expect(tx?.decoding).toBe('complete');
    // The typed expiry ordering binds the signed expiration and the signed reference block
    // (F4-R12, F4-R14, F4-R15): here the build-time head, block 1.
    const { attempt, signed } = await storedAttempt(env, sub.operationId);
    expect(referenced(env, signed)).toBe(1);
    expect(attempt.ordering).toEqual({
      kind: 'expiry',
      expiresAtMs: signed.expiration,
      lastValidHeight: 1n + TAPOS_WINDOW,
      refBlockHash: signed.refBlockHash,
    });
  });

  it('charges account creation and the memo fee, and decodes the memo', async () => {
    const env = createTronEnv();
    const fee = await env.run(
      env.bc.estimateFee({ to: RECIPIENT, amount: 1n, memo: 'order 7' }),
    );
    expect(fee.charges.map((c) => [c.label, c.amount.base])).toEqual([
      ['bandwidth', 100_000n],
      ['activation', 1_000_000n],
      ['memo', 1_000_000n],
    ]);
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 1n, memo: 'order 7' }),
    );
    await env.mineWhile(sub.wait({ finality: 'final' }));
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers[0]).toMatchObject({ memo: 'order 7' });
    expect(env.node.exists(RECIPIENT)).toBe(true);
  });

  it('transfers USDT with an evidenced Transfer event', async () => {
    const env = createTronEnv();
    withToken(env);
    const sub = await env.run(
      env.bc.transfer({ asset: TOKEN, to: RECIPIENT, amount: '2.5' }),
    );
    const final = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(final.status.state).toBe('final');
    expect(env.node.tokenBalance(USDT, RECIPIENT)).toBe(2_500_000n);
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('proves failed a transfer included with too little energy (OUT_OF_ENERGY)', async () => {
    const env = createTronEnv();
    withToken(env);
    const sub = await env.run(
      env.bc.transfer({ asset: TOKEN, to: RECIPIENT, amount: 1n }),
    );
    env.node.energyFactor = 300n; // dynamic energy rose after the estimate
    await expect(env.mineWhile(sub.wait({ finality: 'final' }))).rejects.toMatchObject({
      code: 'TX_REVERTED',
    });
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op?.state).toBe('failed');
    expect(env.node.tokenBalance(USDT, RECIPIENT)).toBe(0n);
  });

  it('never reports success for a token that moved nothing and logged nothing (lesson 7)', async () => {
    const env = createTronEnv();
    env.node.deployToken(USDT, { symbol: 'USDT', decimals: 6, mode: 'no-log' });
    env.node.mintToken(USDT, env.address, 1_000n);
    const sub = await env.run(
      env.bc.transfer({ asset: TOKEN, to: RECIPIENT, amount: 5n }),
    );
    await expect(env.mineWhile(sub.wait({ finality: 'final' }))).rejects.toMatchObject({
      code: 'TX_REVERTED',
    });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('failed');
  });

  it('counts a fee-on-transfer token as executed: from the sender to the recipient, any positive amount (F5)', async () => {
    const env = createTronEnv();
    env.node.deployToken(USDT, { symbol: 'USDT', decimals: 6, mode: 'fee' });
    env.node.mintToken(USDT, env.address, 1_000_000n);
    const sub = await env.run(
      env.bc.transfer({ asset: TOKEN, to: RECIPIENT, amount: 100n }),
    );
    const final = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(final.status.state).toBe('final');
    expect(await env.run(env.bc.getOperation(sub.operationId))).toMatchObject({
      state: 'final',
      outcome: 'executed',
    });
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers.map((t) => [t.to.canonical, t.amount?.base])).toEqual([
      [RECIPIENT, 99n],
      [toBase58Address(FEE_COLLECTOR), 1n],
    ]);
  });

  it('treats a base58 and a hex recipient as one intent under one idempotency key (F11)', async () => {
    const env = createTronEnv();
    const first = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 5n }, { idempotencyKey: 'same' }),
    );
    const again = await env.run(
      env.bc.transfer(
        { to: toHexAddress(RECIPIENT), amount: 5n },
        { idempotencyKey: 'same' },
      ),
    );
    expect(again.operationId).toBe(first.operationId);
  });

  it('fails before signing when the sender was never activated', async () => {
    const { signer, calls } = countingSigner();
    const env = createTronEnv({ fund: 0n, signer });
    expect(env.node.exists(env.address)).toBe(false);
    await expect(
      env.run(env.bc.transfer({ to: RECIPIENT, amount: 1n })),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(calls()).toBe(0);
  });

  it('proves expiry when the transaction never lands, then rebuilds it on request', async () => {
    const { signer, calls } = countingSigner();
    const env = createTronEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 7n }, { idempotencyKey: 'x1' }),
    );
    // The node keeps it pooled but never includes it; it expires and leaves the pool.
    await expect(
      env.mineWhile(sub.wait({ finality: 'final' }), { include: false, maxBlocks: 60 }),
    ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('expired');
    // Expired only through the proofs: the attested reference block bounds the scan.
    const first = await storedAttempt(env, sub.operationId);
    expect(await env.stores.operations.getObservation(first.attempt.id)).toMatchObject({
      state: 'expired',
      evidence: 'proven',
    });
    await expect(
      env.run(env.bc.replace(sub.operationId, { fee: 'fast' })),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    expect(rebuilt.attempt?.id).not.toBe(sub.attempt?.id);
    await env.mineWhile(rebuilt.wait({ finality: 'final' }));
    expect(env.node.balance(RECIPIENT)).toBe(7n);
    expect(calls()).toBe(2);
    // The original never landed; the rebuilt Attempt carries its own signed reference.
    expect(env.node.transaction(sub.attempt?.id ?? '')).toBeUndefined();
    const second = await storedAttempt(env, sub.operationId, 1);
    expect(second.attempt.ref.id).toBe(rebuilt.attempt?.id);
    expect(second.attempt.ordering).toEqual({
      kind: 'expiry',
      expiresAtMs: second.signed.expiration,
      lastValidHeight: BigInt(referenced(env, second.signed)) + TAPOS_WINDOW,
      refBlockHash: second.signed.refBlockHash,
    });
    expect(second.signed.expiration).toBeGreaterThan(first.signed.expiration);
  });

  it('follows a reorg of an unsolidified block and still reaches finality', async () => {
    const env = createTronEnv();
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 9n }));
    env.node.mine();
    await env.run(sub.wait({ confirmations: 1 }));
    const reorged: unknown[] = [];
    env.aio.on('tx.reorged', (e) => reorged.push(e));
    env.node.reorg(1);
    await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(env.node.balance(RECIPIENT)).toBe(9n);
    expect(reorged.length).toBeGreaterThanOrEqual(1);
  });

  describe('crash and recovery', () => {
    function crashEnv() {
      const faulty = new FaultyOperationStore(new MemoryOperationStore());
      const { signer, calls } = countingSigner();
      const env = createTronEnv({ stores: { operations: faulty }, signer });
      return { env, faulty, calls };
    }

    it('rebroadcasts a signed-but-never-sent transfer after the process died, signing once', async () => {
      const { env, faulty, calls } = crashEnv();
      faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.inPool(ref)]).toEqual(['signed', false]);
      const restarted = await env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      expect(env.node.inPool(ref)).toBe(true);
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 3n }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(3n);
    });

    it('recovers a broadcast that was never recorded: the node answers "duplicate"', async () => {
      const { env, faulty, calls } = crashEnv();
      faulty.crashOn({
        method: 'update',
        timing: 'before',
        when: patchState('submitted'),
      });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: 4n }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.inPool(ref)]).toEqual(['signed', true]);
      const restarted = await env.restart({ killPrevious: true });
      expect(await env.run(restarted.aio.operations.recover())).toMatchObject({
        rebroadcast: 1,
        failed: 0,
      });
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: 4n }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['submitted', 1]);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(4n);
    });
  });

  describe('lying and lagging endpoints', () => {
    it('confirms a transfer built on a forged reference head, and never expires or rebuilds it (F4-R14)', async () => {
      const { signer, calls } = countingSigner();
      const env = createTronEnv({ signer });
      // The endpoint's identity and height probes run on the honest head first. A height a
      // probe saw only ever raises the transport's highest height, so a forged one there
      // would stall the monitor (liveness only); the forgery below reaches the builder.
      await env.run(env.bc.getBlockHeight());
      const H = env.node.head;
      const head = env.node.block(H) as { id: string; timestamp: number };
      // The build-time endpoint claims the head is block H + 65,536 with block H's hash
      // bytes behind that height: the signed reference is really block H (the same low 16
      // bits), while the ordering records the forged height.
      const n = H + 65_536;
      let forging = true;
      env.node.intercept('main', '/wallet/getblock', (request) =>
        forging && request.json().id_or_num === undefined
          ? {
              json: {
                blockID: n.toString(16).padStart(16, '0') + head.id.slice(16),
                block_header: {
                  raw_data: {
                    number: n,
                    parentHash: env.node.block(H - 1)?.id,
                    timestamp: head.timestamp,
                  },
                },
              },
            }
          : undefined,
      );
      // Both receipt indexes lag, so only the negative proof could end the Operation.
      let lagging = true;
      for (const path of [
        '/wallet/gettransactioninfobyid',
        '/walletsolidity/gettransactioninfobyid',
      ]) {
        env.node.intercept('main', path, () => (lagging ? { json: {} } : undefined));
      }
      // The blocks the proofs read by hash (JSON-RPC): the scan's walk.
      const scanned: string[] = [];
      env.node.intercept('main', '/jsonrpc', (request) => {
        const { method, params } = request.json<{ method: string; params: unknown[] }>();
        if (method === 'eth_getBlockByHash') {
          scanned.push(String(params[0]).replace(/^0x/, ''));
        }
        return undefined;
      });
      const sub = await env.run(
        env.bc.transfer({ to: RECIPIENT, amount: 11n }, { idempotencyKey: 'forged' }),
      );
      forging = false;
      const { attempt, signed } = await storedAttempt(env, sub.operationId);
      expect(referenced(env, signed)).toBe(H);
      expect(attempt.ordering).toEqual({
        kind: 'expiry',
        expiresAtMs: signed.expiration,
        lastValidHeight: BigInt(n) + TAPOS_WINDOW,
        refBlockHash: head.id.slice(16, 32),
      });
      const waiting = sub.wait({ finality: 'final' });
      waiting.catch(() => undefined);
      await mine(env, 40);
      // The transfer is in block H + 1, and the solidified chain is past its expiration.
      const id = sub.attempt?.id ?? '';
      expect(env.node.transaction(id)?.blockNumber).toBe(H + 1);
      expect(env.node.block(env.node.solid)?.timestamp).toBeGreaterThan(
        signed.expiration,
      );
      // The stored height is above every block, so the proof searched the heights TaPoS can
      // match, found block H and scanned its window down to the transfer: undecided.
      expect(scanned).toContain(env.node.block(H + 1)?.id);
      expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
        'submitted',
      );
      expect(await env.stores.operations.getObservation(attempt.id)).toMatchObject({
        evidence: 'observed',
      });
      await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
      lagging = false;
      const final = await env.mineWhile(waiting);
      expect(final.status).toMatchObject({
        state: 'final',
        evidence: 'proven',
        blockHeight: BigInt(H + 1),
      });
      expect(env.node.balance(RECIPIENT)).toBe(11n);
      expect(calls()).toBe(1);
    });

    it('decides nothing on an impossible answer: a failed result for an included TRX transfer (F4-R10)', async () => {
      const env = createTronEnv();
      // The lone endpoint serves the included transfer with a failed result, which java-tron
      // never records for a TransferContract; its honest answer comes from the same node.
      const honest = env.node.endpoint('honest');
      let lying = true;
      let lies = 0;
      for (const path of [
        '/wallet/gettransactionbyid',
        '/walletsolidity/gettransactionbyid',
      ]) {
        env.node.intercept('main', path, async (request) => {
          if (!lying) return undefined;
          const reply = await env.node.fetch.fetch(`${honest}${path}`, {
            method: 'POST',
            body: request.body ?? '',
          });
          const json = (await reply.json()) as Record<string, unknown>;
          if (json.ret === undefined) return { json };
          lies += 1;
          return { json: { ...json, ret: [{ contractRet: 'REVERT' }] } };
        });
      }
      const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 13n }));
      const waiting = sub.wait({ finality: 'final' });
      waiting.catch(() => undefined);
      await mine(env, 12);
      expect(env.node.transaction(sub.attempt?.id ?? '')?.blockNumber).toBe(2);
      expect(env.node.solid).toBeGreaterThan(2);
      expect(lies).toBeGreaterThan(0);
      expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
        'submitted',
      );
      lying = false;
      expect((await env.mineWhile(waiting)).status).toMatchObject({
        state: 'final',
        evidence: 'proven',
      });
      expect(env.node.balance(RECIPIENT)).toBe(13n);
    });

    it("keeps the Operation when a lone endpoint answers 'rejected' for bytes it relayed (spec §8.2)", async () => {
      const { signer, calls } = countingSigner();
      const env = createTronEnv({ signer });
      const relay = env.node.endpoint('relay');
      let lies = 0;
      env.node.intercept('main', '/wallet/broadcasthex', async (request) => {
        // It passes the bytes on, then claims a rejection our bytes cannot deserve.
        await env.node.fetch.fetch(`${relay}/wallet/broadcasthex`, {
          method: 'POST',
          body: request.body ?? '',
        });
        lies += 1;
        return {
          json: {
            result: false,
            code: 'CONTRACT_VALIDATE_ERROR',
            message: 'Contract validate error : Amount must be greater than 0.',
          },
        };
      });
      const sub = await env.run(
        env.bc.transfer({ to: RECIPIENT, amount: 12n }, { idempotencyKey: 'lie' }),
      );
      // The engine looked up its own txID first and found it pooled: the claim ends nothing.
      expect([sub.state, lies, env.node.inPool(sub.attempt?.id ?? '')]).toEqual([
        'submitted',
        1,
        true,
      ]);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(12n);
      expect(calls()).toBe(1);
    });

    it.each(CLAIMS)(
      "never ends the Operation on a lone endpoint's unverified claim %s: %s (lesson 21)",
      async (code, message) => {
        const { signer, calls } = countingSigner();
        const env = createTronEnv({ signer });
        const relay = env.node.endpoint('relay');
        // The only endpoint keeps our bytes, relays nothing and claims them invalid.
        let held: string | undefined;
        env.node.intercept('main', '/wallet/broadcasthex', (request) => {
          if (held !== undefined) return undefined;
          held = request.body ?? '';
          return { json: { result: false, code, message } };
        });
        await expect(
          env.run(
            env.bc.transfer({ to: RECIPIENT, amount: 12n }, { idempotencyKey: 'lie' }),
          ),
        ).rejects.toMatchObject({ code: 'TX_REFUSED' });
        const op = await env.stores.operations.getByKey('default', 'lie');
        expect(op?.state).toBe('stalled');
        expect(
          await env.stores.operations.getObservation(op?.attempts[0]?.id ?? ''),
        ).toMatchObject({ state: 'refused', evidence: 'observed' });
        // Later it relays the bytes it kept: they land, and the Operation confirms them.
        await env.node.fetch.fetch(`${relay}/wallet/broadcasthex`, {
          method: 'POST',
          body: held ?? '',
        });
        const done = await env.mineWhile(
          env.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' }),
        );
        expect(done.status).toMatchObject({ state: 'final', evidence: 'proven' });
        expect(done.operation?.state).toBe('final');
        expect(env.node.balance(RECIPIENT)).toBe(12n);
        expect(calls()).toBe(1);
      },
    );

    it.each(CLAIMS)(
      'confirms our transfer when a lone endpoint relays it yet claims %s: %s (lesson 21)',
      async (code, message) => {
        const { signer, calls } = countingSigner();
        const env = createTronEnv({ signer });
        const relay = env.node.endpoint('relay');
        // Its pool view lags, so the engine's own-ref lookup finds nothing yet.
        let lagging = true;
        env.node.intercept('main', '/wallet/gettransactionfrompending', () =>
          lagging ? { json: {} } : undefined,
        );
        env.node.intercept('main', '/wallet/broadcasthex', async (request) => {
          await env.node.fetch.fetch(`${relay}/wallet/broadcasthex`, {
            method: 'POST',
            body: request.body ?? '',
          });
          return { json: { result: false, code, message } };
        });
        await expect(
          env.run(
            env.bc.transfer({ to: RECIPIENT, amount: 15n }, { idempotencyKey: 'relay' }),
          ),
        ).rejects.toMatchObject({ code: 'TX_REFUSED' });
        const op = await env.stores.operations.getByKey('default', 'relay');
        expect(op?.state).toBe('stalled');
        expect(env.node.inPool(op?.attempts[0]?.ref.id ?? '')).toBe(true);
        lagging = false;
        const done = await env.mineWhile(
          env.bc.waitForConfirmation(op?.id ?? '', { finality: 'final' }),
        );
        expect(done.status).toMatchObject({ state: 'final', evidence: 'proven' });
        expect(env.node.balance(RECIPIENT)).toBe(15n);
        expect(calls()).toBe(1);
      },
    );

    it('retries a history entry the node serves only from its pool, never skipping it (F4-R14)', async () => {
      const env = createTronEnv({ indexer: true });
      const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 14n }));
      const id = sub.attempt?.id ?? '';
      // The node's own pool copy of the transfer, as it serves it while pending.
      const pooled = await (
        await env.node.fetch.fetch(
          'https://main.tron.test/wallet/gettransactionfrompending',
          {
            method: 'POST',
            body: JSON.stringify({ value: id }),
          },
        )
      ).text();
      await env.mineWhile(sub.wait({ finality: 'final' }));
      // TronGrid lists the confirmed transfer, but the full node is behind: it serves only
      // its pool copy, which a page must neither list nor skip.
      let behind = true;
      const ours = (request: FakeRequest) => behind && request.json().value === id;
      env.node.intercept('main', '/wallet/gettransactionbyid', (request) =>
        ours(request) ? { json: {} } : undefined,
      );
      env.node.intercept('main', '/wallet/gettransactionfrompending', (request) =>
        ours(request)
          ? { text: pooled, headers: { 'content-type': 'application/json' } }
          : undefined,
      );
      await expect(env.run(env.bc.history(RECIPIENT))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      behind = false;
      const page = await env.run(env.bc.history(RECIPIENT));
      expect(page.items).toMatchObject([
        { id, transfers: [{ to: { canonical: RECIPIENT }, amount: { base: 14n } }] },
      ]);
      expect(page.items[0]?.block).toBeDefined();
    });
  });

  it('scans final blocks for deposits, marking a junk token unresolved (R35)', async () => {
    const env = createTronEnv();
    withToken(env);
    env.node.deployToken(JUNK, {
      symbol: 'JUNK',
      decimals: 6,
      mode: 'reverting-metadata',
    });
    env.node.mintToken(JUNK, env.address, 100n);
    await env.run(env.bc.transfer({ to: RECIPIENT, amount: 4n }));
    await env.run(env.bc.transfer({ asset: TOKEN, to: RECIPIENT, amount: 2n }));
    // The handle refuses the junk token (its metadata fails), so send it as a third party would.
    await expect(
      env.run(
        env.bc.transfer({
          asset: { standard: 'trc20', contract: JUNK },
          to: RECIPIENT,
          amount: 5n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    const head = env.node.block(env.node.head) as { id: string; timestamp: number };
    const junk = signedTransaction({
      refBlockBytes: head.id.slice(12, 16),
      refBlockHash: head.id.slice(16, 32),
      expiration: head.timestamp + 60_000,
      timestamp: head.timestamp + 7,
      feeLimit: 100_000_000,
      contract: {
        type: 'TriggerSmartContract',
        owner: KEY_HEX,
        contract: toHexAddress(JUNK),
        data: encodeTransfer(RECIPIENT, 5n),
      },
    });
    await env.run(
      env.node.fetch.fetch('https://main.tron.test/wallet/broadcasthex', {
        method: 'POST',
        body: JSON.stringify({ transaction: junk.hex }),
      }),
    );
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
      i < 200 &&
      seen.flatMap((e) => (e.type === 'block' ? e.transactions : [])).length < 3;
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
    ).toEqual([['0.000004 TRX'], ['0.000002 USDT'], ['ASSET_RESOLUTION']]);
    expect(txs[2]).toMatchObject({
      decoding: 'partial',
      transfers: [
        { unresolved: { asset: { standard: 'trc20', contract: JUNK }, amount: 5n } },
      ],
    });
  });

  it('hands the handle its own native TronWeb client', async () => {
    const env = createTronEnv();
    const client = await env.run(native(env.bc, 'tronweb'));
    expect(await env.run(native(env.bc, 'tronweb'))).toBe(client);
    expect(await env.run(client.trx.getBalance(env.address))).toBe(1_000_000_000);
    await env.run(env.aio.close());
  });
});
