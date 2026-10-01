/**
 * The TON family end to end: the public API (`CryptoAio`, `Blockchain`, the operation store,
 * crash and fencing) over the scripted toncenter node. Every fund-critical path is driven to
 * its end: a proven verdict, a proven expiry, or a proof that stays undecided while the
 * chain cannot decide it ("not included" waits for the message's lifetime and reads only
 * the wallet's hash-linked liteserver chain, from the attempt's own recorded
 * `validFrom`). A check that claims a proof path reads what that path reads.
 */
import { ed25519 } from '@noble/curves/ed25519';
import {
  Cell,
  beginCell,
  external,
  loadMessage,
  storeMessage,
  storeMessageRelaxed,
  type MessageRelaxed,
} from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import type { TonSeqnoOrdering } from '../../../src/adapters/ton';
import { friendlyAddress } from '../../../src/adapters/ton/address';
import { CHAIN_TIME_TOLERANCE } from '../../../src/adapters/ton/builder';
import { jettonMessage, nativeMessage } from '../../../src/adapters/ton/messages';
import { REASONS } from '../../../src/adapters/ton/trace';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { OperationPatch } from '../../../src/core/store/types';
import type { FakeRequest } from '../../../src/testing/fake-fetch';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import { countingSigner, createTonEnv } from './support/env';
import { signedBoc } from './support/harness';
import { KEY, PUBLIC_KEY } from './support/vectors';

const GRAM = 1_000_000_000n;
const TESTNET = -3;
const FRESH = `0:${'11'.repeat(32)}`;
const PAYER = `0:${'33'.repeat(32)}`;
const SMALL = `0:${'44'.repeat(32)}`;
const REVERTER = `0:${'55'.repeat(32)}`;
const MASTER = `0:${'77'.repeat(32)}`;
/** A testnet wallet's form of a raw address: bounceable (`kQ…`) or not (`0Q…`). */
const friendly = (raw: string, bounceable: boolean): string =>
  friendlyAddress(0, Buffer.from(raw.slice(2), 'hex'), {
    bounceable,
    testOnly: true,
    urlSafe: true,
  });
const FRESH_UQ = friendly(FRESH, false);
const FRESH_EQ = friendly(FRESH, true);
/** The built-in networks' `params.finalitySkewBlocks` and `validForSeconds`. */
const FINALITY_SKEW = 10;
const VALID_FOR = 60;
/** Blocks (one per fake second) that outlast a message's lifetime and the proof's skew. */
const PAST_LIFETIME = VALID_FOR + FINALITY_SKEW + 20;
/** The liteserver's refusal of a seqno it does not expect (collator.cpp, wallet code 33). */
const SEQNO_REFUSAL = `External message was not accepted: cannot run message on account: inbound external message rejected by transaction ${'AB'.repeat(32)}:\nexitcode=33, steps=13, gas_used=0`;

// Each scenario mines at most a few hundred blocks, and every mining loop has a step budget
// sized to it, so a stuck scenario fails by name (`did not settle within …`) well inside this.
jest.setTimeout(30_000);

type Env = Awaited<ReturnType<typeof createTonEnv>>;

const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
/** A hash query parameter (hex or base64) in hex. */
const hexOf = (value: string | null): string =>
  value === null
    ? ''
    : /^[0-9a-fA-F]{64}$/.test(value)
      ? value.toLowerCase()
      : Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
          'hex',
        );

const recordOf = async (env: Env, operationId: string) => {
  const record = await env.stores.operations.get('default', operationId);
  if (!record) throw new Error(`no operation ${operationId}`);
  return record;
};

/** The ordering the build recorded on an Operation's Attempt. */
const orderingOf = async (env: Env, operationId: string, index = 0) =>
  (await recordOf(env, operationId)).attempts[index]?.ordering as TonSeqnoOrdering;

/** The wallet transactions that ran the external message `id` (its TEP-467 hash). */
const runsOf = (env: Env, id: string) =>
  env.node.transactions().filter((tx) => tx.inMsg.hashNorm === id);

/** The external messages sent to the node, as base64 BOCs. */
const sentBocs = (env: Env): string[] =>
  env.node.fetch.calls
    .filter((call) => call.url.endsWith('/sendBocReturnHash'))
    .map((call) => (JSON.parse(call.body ?? '{}') as { boc: string }).boc);

/** The routes (v2 and v3) the node served since `from`, an index into `served`. */
const servedSince = (env: Env, from: number) =>
  env.node.served.slice(from).map((served) => served.route);

/** The URLs of the requests the node was sent since `from`, an index into `fetch.calls`. */
const urlsSince = (env: Env, from: number) =>
  env.node.fetch.calls.slice(from).map((call) => new URL(call.url));

/** Whether one of `urls` asked the indexer for the history of `account` before `lt`. */
const askedHistoryBefore = (urls: readonly URL[], lt: bigint) =>
  urls.some(
    (url) =>
      url.pathname === '/api/v3/transactions' &&
      url.searchParams.get('end_lt') === (lt - 1n).toString(),
  );

/**
 * Mines `blocks` blocks, one per fake second, with a worker pass after each, and holds
 * `check` after every pass: what the store says at any moment.
 */
async function monitorFor(env: Env, blocks: number, check: () => Promise<void>) {
  for (let i = 0; i < blocks; i++) {
    env.node.mine();
    await env.clock.advance(1_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
    await check();
  }
}

type Json = Record<string, unknown>;

/**
 * A lone indexer that edits its own answers to the transaction routes (`/transactions`,
 * `/transactionsByMessage`, `/traces`): `edit` gets the node's honest answer. Every such
 * request's URL is kept in `asked`.
 */
function lyingIndexer(env: Env, edit: (route: string, json: Json, url: URL) => Json) {
  const asked: URL[] = [];
  const routes = new Set(['/transactions', '/transactionsByMessage', '/traces']);
  env.node.intercept = (_endpoint, route, request: FakeRequest) => {
    if (!routes.has(route) || request.url.searchParams.has('honest')) return undefined;
    asked.push(request.url);
    const url = new URL(request.url.href);
    url.searchParams.set('honest', '1');
    return (async () => {
      const response = await env.node.fetch.fetch(url.href, { method: request.method });
      return {
        status: response.status,
        json: edit(route, (await response.json()) as Json, request.url),
      };
    })();
  };
  return asked;
}

/**
 * A v4r2 request of the test key's wallet (deploying it at seqno 0) with each message's own
 * send mode: our builder always signs `SEND_MODE`, other software holding the key need not.
 */
function v4Request(
  seqno: number,
  validUntil: number,
  messages: readonly (readonly [number, MessageRelaxed])[],
): string {
  const contract = WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(PUBLIC_KEY, 'hex'),
  });
  const signing = beginCell()
    .storeUint(contract.walletId, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32)
    .storeUint(0, 8);
  for (const [mode, message] of messages) {
    signing.storeUint(mode, 8).storeRef(beginCell().store(storeMessageRelaxed(message)));
  }
  const cell = signing.endCell();
  const signature = ed25519.sign(cell.hash(), Buffer.from(KEY, 'hex'));
  const body = beginCell()
    .storeBuffer(Buffer.from(signature))
    .storeSlice(cell.beginParse())
    .endCell();
  const init = seqno === 0 ? { init: contract.init } : {};
  return beginCell()
    .store(storeMessage(external({ to: contract.address, body, ...init })))
    .endCell()
    .toBoc()
    .toString('base64');
}

describe('TON end to end (scripted toncenter node)', () => {
  // Determinism: the container builds its transports itself with the core's default
  // jitter (`Math.random`), which the public options cannot fix; it is fixed here instead.
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deploys the wallet, pays a fresh address to final and resolves the canonical hash', async () => {
    const { signer, calls } = countingSigner();
    const env = await createTonEnv({ signer });
    const sub = await env.run(
      env.bc.transfer({ to: FRESH_UQ, amount: '1.5', memo: 'invoice 7' }),
    );
    expect(sub.attempt).toMatchObject({ idKind: 'message-hash', canonical: false });
    // The build records the chain time its lifetime runs from, and the Operation's
    // reservation follows the built ordering.
    const record = await recordOf(env, sub.operationId);
    const ordering = record.attempts[0]?.ordering as TonSeqnoOrdering;
    const builtAt = env.node.block(env.node.head)?.genUtime as number;
    expect(ordering).toEqual({
      kind: 'seqno',
      seqno: 0n,
      validUntil: builtAt + VALID_FOR,
      validFrom: builtAt,
    });
    expect(record.reservation).toEqual(ordering);
    const done = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(done.operation?.state).toBe('final');
    expect([env.node.balance(FRESH), calls()]).toEqual([1_500_000_000n, 1]);
    const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
    expect(status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    // The canonical id is the wallet transaction's hash, resolved after signing.
    const txHash = status.txHash as string;
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(txHash).not.toBe(sub.attempt?.id);
    expect(runsOf(env, sub.attempt?.id ?? '').map((tx) => tx.hash)).toEqual([txHash]);
    expect(await env.run(env.bc.getTransactionStatus(txHash))).toMatchObject({
      state: 'final',
    });
    for (const id of [sub.attempt?.id ?? '', txHash]) {
      const tx = await env.run(env.bc.getTransaction(id));
      expect(tx?.transfers[0]).toMatchObject({ memo: 'invoice 7' });
      expect(tx?.transfers[0]?.amount?.toDecimalString()).toBe('1.5');
    }
  });

  it('refuses a batch before anything is signed or sent: one output per transfer', async () => {
    const { signer, calls } = countingSigner();
    const env = await createTonEnv({ signer });
    expect(env.bc.supports('batch-transfer')).toBe(false);
    await expect(
      env.run(
        env.bc.transfer({
          outputs: [
            { to: FRESH_UQ, amount: 1n },
            { to: FRESH_UQ, amount: 2n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect([calls(), sentBocs(env)]).toEqual([0, []]);
  });

  // The recipient's address decides bounce: a raw or `EQ…` address to a fresh wallet
  // bounces the value back, and the `UQ…` form of it lands.
  describe("the recipient's bounce flag", () => {
    it('bounces the bounceable form and lands the non-bounceable one; the two are two intents', async () => {
      const env = await createTonEnv();
      const bounced = await env.run(
        env.bc.transfer({ to: FRESH_EQ, amount: GRAM }, { idempotencyKey: 'eq' }),
      );
      await expect(
        env.mineWhile(bounced.wait({ finality: 'final' })),
      ).rejects.toMatchObject({ code: 'TX_REVERTED' });
      expect(
        await env.run(env.bc.getTransactionStatus(bounced.operationId)),
      ).toMatchObject({
        state: 'failed',
        evidence: 'proven',
        reason: REASONS.bounced,
      });
      expect(env.node.balance(FRESH)).toBe(0n);
      // The other form of the same address is another intent: the bounce flag is hashed.
      await expect(
        env.run(
          env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'eq' }),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const landed = await env.run(env.bc.transfer({ to: FRESH_UQ, amount: GRAM }));
      await env.mineWhile(landed.wait({ finality: 'final' }));
      expect(env.node.balance(FRESH)).toBe(GRAM);
    });

    it('fails only a bounce that brought the value back; a value the recipient kept is final', async () => {
      const env = await createTonEnv();
      env.node.deployReverter(REVERTER);
      const pay = async (to: string, amount: bigint) => {
        const sub = await env.run(env.bc.transfer({ to, amount }));
        return env
          .mineWhile(sub.wait({ finality: 'final' }))
          .then(() => 'final')
          .catch((error: { code?: string }) => error.code);
      };
      // A raw address carries no flag and is bounceable, so it bounces too.
      expect(await pay(FRESH, GRAM)).toBe('TX_REVERTED');
      expect(env.node.balance(FRESH)).toBe(0n);
      // Below the bounce's own cost the chain keeps the value with the recipient (`nofunds`):
      // paid, so final, never failed (a re-send would pay twice).
      expect(await pay(friendly(SMALL, true), 100_000n)).toBe('final');
      expect(env.node.balance(SMALL)).toBe(100_000n);
      // A contract that throws: the bounceable form comes back, the other stays with it.
      const before = env.node.balance(REVERTER);
      expect(await pay(friendly(REVERTER, true), GRAM)).toBe('TX_REVERTED');
      expect(env.node.balance(REVERTER)).toBe(before);
      expect(await pay(friendly(REVERTER, false), GRAM)).toBe('final');
      expect(env.node.balance(REVERTER)).toBe(before + GRAM);
    });
  });

  describe('the funds path and the fee ceiling', () => {
    it('answers a sender that cannot pay with INSUFFICIENT_FUNDS before anything is signed', async () => {
      // Too little to buy one run's gas: the emulation runs nothing (tonlib buys the
      // run's gas with the balance).
      const drained = countingSigner();
      const env = await createTonEnv({ fund: 5_000n, signer: drained.signer });
      await expect(
        env.run(env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'd' })),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect((await env.stores.operations.getByKey('default', 'd'))?.state).toBe(
        'failed',
      );
      // Enough gas, not the amount: the funds check.
      const short = countingSigner();
      const poor = await createTonEnv({ fund: GRAM / 2n, signer: short.signer });
      await expect(
        poor.run(poor.bc.transfer({ to: FRESH_UQ, amount: GRAM })),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect([drained.calls(), short.calls(), sentBocs(env), sentBocs(poor)]).toEqual([
        0,
        0,
        [],
        [],
      ]);
    });

    it('holds an endpoint to the fee ceiling: retryable, nothing signed, the same key lands later', async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ signer });
      // One endpoint suggests a gas fee above the basechain ceiling (1 GRAM).
      env.node.intercept = (_endpoint, route) =>
        route === '/estimateFee'
          ? {
              json: {
                ok: true,
                result: {
                  '@type': 'query.fees',
                  source_fees: {
                    '@type': 'fees',
                    in_fwd_fee: 1_000_000,
                    storage_fee: 0,
                    gas_fee: 2_000_000_000,
                    fwd_fee: 1_000_000,
                  },
                  destination_fees: [],
                },
              },
            }
          : undefined;
      const intent = { to: FRESH_UQ, amount: 9n * GRAM };
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'c' })),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      // An inflated config forward fee is held to the ceiling before the balance is
      // compared, so with an empty emulation it is never a definitive shortfall.
      const inflated = beginCell()
        .storeUint(0xea, 8)
        .storeUint(2n * GRAM, 64)
        .storeUint(0, 64)
        .storeUint(0, 64)
        .storeUint(0, 32)
        .storeUint(0, 16)
        .storeUint(0, 16)
        .endCell()
        .toBoc()
        .toString('base64');
      env.node.intercept = (_endpoint, route, request) =>
        route === '/estimateFee'
          ? {
              json: {
                ok: true,
                result: {
                  '@type': 'query.fees',
                  source_fees: {
                    '@type': 'fees',
                    in_fwd_fee: 1_000_000,
                    storage_fee: 0,
                    gas_fee: 0,
                    fwd_fee: 0,
                  },
                  destination_fees: [],
                },
              },
            }
          : route === '/getConfigParam' && request.url.searchParams.get('param') === '25'
            ? {
                json: {
                  ok: true,
                  result: {
                    '@type': 'configInfo',
                    config: { '@type': 'tvm.cell', bytes: inflated },
                  },
                },
              }
            : undefined;
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'c' })),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      expect((await env.stores.operations.getByKey('default', 'c'))?.state).toBe(
        'created',
      );
      expect([calls(), sentBocs(env)]).toEqual([0, []]);
      env.node.intercept = undefined;
      const sub = await env.run(env.bc.transfer(intent, { idempotencyKey: 'c' }));
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect([env.node.balance(FRESH), calls()]).toEqual([9n * GRAM, 1]);
    });
  });

  it('fails a transfer the wallet could not pay for', async () => {
    const env = await createTonEnv({ fund: 2n * GRAM });
    const sub = await env.run(env.bc.transfer({ to: FRESH_UQ, amount: '1.5' }));
    // Another spend drains the wallet between the funds check and the inclusion: send mode
    // +2 skips the message, and the seqno is consumed, so this message can never run again.
    env.node.debit(env.address, 1_500_000_000n);
    await expect(env.mineWhile(sub.wait({ finality: 'final' }))).rejects.toMatchObject({
      code: 'TX_REVERTED',
    });
    expect(env.node.seqno(env.address)).toBe(1);
    expect(env.node.balance(FRESH)).toBe(0n);
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'failed',
      evidence: 'proven',
      reason: REASONS.skipped,
    });
  });

  it('keeps one wallet strictly serial', async () => {
    const { signer, calls } = countingSigner();
    const env = await createTonEnv({ signer });
    const results = await env.run(
      Promise.allSettled([
        env.bc.transfer({ to: FRESH_UQ, amount: 1n }, { idempotencyKey: 'a' }),
        env.bc.transfer({ to: FRESH_UQ, amount: 2n }, { idempotencyKey: 'b' }),
      ]),
    );
    const winners = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(winners).toHaveLength(1);
    const first = winners[0] as (typeof winners)[number];
    const busyKey = first.idempotencyKey === 'a' ? 'b' : 'a';
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({
        code: 'SEQUENCE_BUSY',
        retryable: true,
        context: expect.objectContaining({ blockingOperationId: first.operationId }),
      }),
    });
    // The busy one never reached signing and holds no seqno.
    const busy = await env.stores.operations.getByKey('default', busyKey);
    expect([busy?.state, busy?.reservation, calls()]).toEqual(['created', undefined, 1]);
    await env.mineWhile(first.wait({ finality: 'final' }));
    // Retried with its own key once the first is done: the next seqno.
    const next = await env.run(
      env.bc.transfer(
        { to: FRESH_UQ, amount: busyKey === 'a' ? 1n : 2n },
        { idempotencyKey: busyKey },
      ),
    );
    expect(await orderingOf(env, next.operationId)).toMatchObject({ seqno: 1n });
    await env.mineWhile(next.wait({ finality: 'final' }));
    expect([env.node.seqno(env.address), env.node.balance(FRESH), calls()]).toEqual([
      2,
      3n,
      2,
    ]);
  });

  it('expires a message the chain never saw, proven by shard time from its own chain, then rebuilds it', async () => {
    const { signer, calls } = countingSigner();
    const env = await createTonEnv({ fund: 0n, signer, node: { shardLagSeconds: 5 } });
    // A real deposit gives the undeployed wallet a chain for the proof to walk.
    env.node.inject(PAYER, env.address, 10n * GRAM, beginCell().endCell());
    env.node.mine();
    const expiredAt: { attested?: number } = {};
    env.aio.on('operation.state', (event) => {
      if (event.to === 'expired' && expiredAt.attested === undefined) {
        expiredAt.attested = env.node.head - FINALITY_SKEW;
      }
    });
    // The node takes the message, and every resend of it, then loses them.
    env.node.swallow = true;
    const sub = await env.run(
      env.bc.transfer({ to: FRESH_UQ, amount: 5n }, { idempotencyKey: 'x' }),
    );
    const { validUntil } = await orderingOf(env, sub.operationId);
    // Only an expired Operation is rebuilt (the state gate; this claims nothing on proofs).
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      message: expect.stringContaining('only expired operations can be rebuilt'),
    });
    const served = env.node.served.length;
    const called = env.node.fetch.calls.length;
    await expect(
      env.mineWhile(sub.wait({ finality: 'final' }), PAST_LIFETIME + 20),
    ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    // Proven at an attested block whose shard is past `valid_until` too, not earlier.
    const attested = env.node.block(expiredAt.attested as number);
    expect(attested?.shards[0]?.genUtime).toBeGreaterThanOrEqual(validUntil);
    expect(attested?.genUtime).toBeGreaterThanOrEqual(validUntil + 5);
    // "Not included" read the wallet's own chain from the liteserver, back to its
    // start (the deposit), and the anchored history before it.
    const routes = servedSince(env, served);
    expect(routes).toEqual(expect.arrayContaining(['/getShards', '/getTransactions']));
    const [deposit] = env.node.transactions();
    expect(askedHistoryBefore(urlsSince(env, called), deposit?.lt ?? 0n)).toBe(true);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('expired');
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'expired',
      evidence: 'proven',
    });
    env.node.swallow = false;
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    expect(rebuilt.attempts.map((a) => a.purpose)).toEqual(['original', 'rebuild']);
    expect(rebuilt.attempt?.id).not.toBe(sub.attempt?.id);
    // The wallet never ran: the rebuild takes seqno 0 again, with its own lifetime.
    const again = await orderingOf(env, sub.operationId, 1);
    expect(again.seqno).toBe(0n);
    expect(again.validFrom).toBeGreaterThan(validUntil);
    const done = await env.mineWhile(rebuilt.wait({ finality: 'final' }));
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect([
      runsOf(env, sub.attempt?.id ?? ''),
      env.node.balance(FRESH),
      calls(),
    ]).toEqual([[], 5n, 2]);
  });

  it('waits out indexer lag without a false verdict, past the lifetime', async () => {
    const env = await createTonEnv({ node: { indexerLag: 200 } });
    const sub = await env.run(env.bc.transfer({ to: FRESH_UQ, amount: 7n }));
    const served = env.node.served.length;
    const called = env.node.fetch.calls.length;
    for (let i = 0; i < PAST_LIFETIME; i++) {
      env.node.mine();
      await env.clock.advance(1_000);
      await env.run(env.aio.monitor.runOnce({ workerId: 'w' }));
      // Our own landed message is never reported `replaced`, not even as observed, nor
      // `expired` once its lifetime has passed: the chain holds it, unindexed.
      const status = await env.run(env.bc.getTransactionStatus(sub.operationId));
      expect(['pending', 'dropped']).toContain(status.state);
    }
    expect(env.node.seqno(env.address)).toBe(1);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe(
      'submitted',
    );
    // The proof reached the chain walk, which found our transaction and asked the indexer
    // for it: still unindexed, so nothing was decided.
    expect(servedSince(env, served)).toContain('/getTransactions');
    const [ours] = runsOf(env, sub.attempt?.id ?? '');
    expect(
      urlsSince(env, called).some(
        (url) =>
          url.pathname === '/api/v3/transactions' &&
          hexOf(url.searchParams.get('hash')) === ours?.hash,
      ),
    ).toBe(true);
    env.node.indexerLag = 0;
    const done = await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(done.operation?.state).toBe('final');
    expect(env.node.balance(FRESH)).toBe(7n);
  });

  describe('fund-critical resets and replays', () => {
    it("ends a transfer whose seqno another request took only once its own lifetime has passed, walking back to the attempt's recorded start", async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ fund: 0n, signer });
      // A wallet with a long history, all of it older than any message built from now on,
      // less the builder's chain-time tolerance.
      for (let i = 0; i < 40; i++) {
        env.node.inject(PAYER, env.address, GRAM / 4n, beginCell().endCell());
      }
      env.node.mine();
      await env.clock.advance((CHAIN_TIME_TOLERANCE + 100) * 1_000);
      env.node.mine();
      // Our message never reaches the chain; software sharing the key takes seqno 0 first.
      env.node.swallow = true;
      const sub = await env.run(env.bc.transfer({ to: FRESH_UQ, amount: GRAM }));
      const attempt = (await recordOf(env, sub.operationId)).attempts[0];
      const { validUntil, validFrom } = await orderingOf(env, sub.operationId);
      const theirs = await signedBoc('v5r1', TESTNET, {
        seqno: 0,
        validUntil: validUntil + 30,
        deploy: true,
        messages: [nativeMessage({ to: PAYER, value: 7n, bounce: false })],
      });
      env.node.swallow = false;
      env.node.submit(theirs.boc);
      env.node.swallow = true;
      let endedAt: number | undefined;
      let walk: string[] = [];
      let mark = env.node.served.length;
      await monitorFor(env, PAST_LIFETIME, async () => {
        const routes = servedSince(env, mark);
        mark = env.node.served.length;
        const state = (await recordOf(env, sub.operationId)).state;
        if (state === 'submitted' || endedAt !== undefined) return;
        endedAt = env.node.head;
        walk = routes.filter((route) => route === '/getTransactions');
      });
      const [taken] = runsOf(env, theirs.hashNorm);
      expect(env.node.seqno(env.address)).toBe(1);
      expect(taken?.now).toBeLessThan(validUntil);
      // The slot was consumed while ours was valid, yet "not included" waited for our
      // lifetime: proven at an attested block past `valid_until`.
      const attested = env.node.block((endedAt as number) - FINALITY_SKEW);
      expect(attested?.genUtime).toBeGreaterThanOrEqual(validUntil);
      expect(await recordOf(env, sub.operationId)).toMatchObject({
        state: 'failed',
        error: { code: 'TX_REPLACED' },
      });
      expect(await env.stores.operations.getObservation(attempt?.id ?? '')).toMatchObject(
        { state: 'replaced', evidence: 'proven' },
      );
      // The walk went back to the recorded start less the tolerance, and no further:
      // one page, not the older history (the widest window would read it all).
      expect(walk).toEqual(['/getTransactions']);
      expect(validFrom).toBe(validUntil - VALID_FOR);
      expect([
        runsOf(env, attempt?.ref.id ?? ''),
        env.node.balance(FRESH),
        calls(),
      ]).toEqual([[], 0n, 1]);
    });

    it('never expires or rebuilds a landed transfer after the wallet was deleted and re-deployed', async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ version: 'v4r2', signer });
      const sub = await env.run(
        env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'ours' }),
      );
      const id = sub.attempt?.id ?? '';
      const attemptId = (await recordOf(env, sub.operationId)).attempts[0]?.id ?? '';
      env.node.mine(2);
      const [ours] = runsOf(env, id);
      expect(env.node.balance(FRESH)).toBe(GRAM);
      // Software sharing the key sends everything and deletes the wallet (+128+32); anyone
      // re-funds it and re-deploys it from its public StateInit: its seqno starts again. The
      // reset falls between monitor passes: a resend of our still-valid message while the
      // wallet is deleted and re-funded would run it again.
      const now = () => Math.floor(env.clock.now() / 1000);
      env.node.submit(
        v4Request(1, now() + VALID_FOR, [
          [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
        ]),
      );
      env.node.mine();
      expect(env.node.status(env.address)).toBe('uninitialized');
      env.node.inject(PAYER, env.address, 2n * GRAM, beginCell().endCell());
      env.node.mine();
      const theirs = await signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil: now() + VALID_FOR,
        deploy: true,
        messages: [nativeMessage({ to: FRESH, value: 5n, bounce: false })],
      });
      env.node.submit(theirs.boc);
      env.node.mine(2);
      expect(env.node.seqno(env.address)).toBe(1);
      // The lone indexer lost our transaction: no lookup, listing or trace shows it.
      const hidden = b64(ours?.hash ?? '');
      lyingIndexer(env, (route, json, url) =>
        route === '/traces'
          ? hexOf(url.searchParams.get('tx_hash')) === ours?.hash
            ? { traces: [], address_book: {} }
            : json
          : {
              ...json,
              transactions: (json.transactions as Json[]).filter(
                (tx) => tx.hash !== hidden,
              ),
            },
      );
      const served = env.node.served.length;
      await monitorFor(env, PAST_LIFETIME, async () => {
        const record = await recordOf(env, sub.operationId);
        const seen = await env.stores.operations.getObservation(attemptId);
        expect(record.state).toBe('submitted');
        expect(['pending', 'dropped']).toContain(seen?.state);
      });
      // The proof walked the wallet's chain past its expiry, reached the chain start after the
      // deletion, found earlier history there, and decided nothing.
      expect(servedSince(env, served)).toEqual(
        expect.arrayContaining(['/getShards', '/getTransactions']),
      );
      expect(env.warnings).toContain('WALLET_RESET_SUSPECTED');
      // Never `expired`, so never rebuilt (the state gate refuses it).
      await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
      // Our message ran once, and only once.
      expect(runsOf(env, id)).toHaveLength(1);
      env.node.intercept = undefined;
      const done = await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(done.status).toMatchObject({ state: 'final', txHash: ours?.hash });
      expect([env.node.balance(FRESH), calls()]).toEqual([GRAM + 5n, 1]);
    });

    it('never takes our own earlier, expired request for the consumer of the seqno our rebuild used', async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ signer });
      // Attempt A for seqno 0 never lands and is proven expired; its rebuild B, for seqno 0
      // again, lands.
      env.node.swallow = true;
      const sub = await env.run(
        env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'r' }),
      );
      await expect(
        env.mineWhile(sub.wait({ finality: 'final' }), PAST_LIFETIME + 20),
      ).rejects.toMatchObject({ code: 'TX_EXPIRED' });
      env.node.swallow = false;
      const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
      const [a, b] = (await recordOf(env, sub.operationId)).attempts;
      expect([a?.ordering.kind, (b?.ordering as TonSeqnoOrdering).seqno]).toEqual([
        'seqno',
        0n,
      ]);
      const aCell = Cell.fromBoc(Buffer.from(a?.raw.data ?? '', 'base64'))[0] as Cell;
      const aBody = loadMessage(aCell.beginParse()).body;
      const aValidUntil = (a?.ordering as TonSeqnoOrdering).validUntil;
      env.node.mine();
      const [landed] = runsOf(env, b?.ref.id ?? '');
      expect(landed).toBeDefined();
      // A lone lying indexer loses B's lookup and shows A's genuine body, as if it ran before
      // A expired, in B's place: on its listing, and at first on its lookup by hash too.
      const lie = (json: Json): Json => ({
        ...json,
        transactions: (json.transactions as Json[]).map((tx) => {
          const inMsg = tx.in_msg as Json;
          if (inMsg.source !== null) return tx;
          return {
            ...tx,
            now: aValidUntil - 5,
            in_msg: {
              ...inMsg,
              hash: aCell.hash().toString('base64'),
              hash_norm: b64(a?.ref.id ?? ''),
              message_content: {
                ...(inMsg.message_content as Json),
                hash: aBody.hash().toString('base64'),
                body: aBody.toBoc().toString('base64'),
              },
            },
          };
        }),
      });
      let everywhere = true;
      const asked = lyingIndexer(env, (route, json, url) =>
        route === '/transactionsByMessage'
          ? { transactions: [], address_book: {} }
          : route === '/transactions' && (everywhere || url.searchParams.has('account'))
            ? lie(json)
            : json,
      );
      await monitorFor(env, PAST_LIFETIME, async () => {
        const record = await recordOf(env, sub.operationId);
        const seen = await env.stores.operations.getObservation(b?.id ?? '');
        expect(record.state).toBe('submitted');
        expect(['pending', 'dropped']).toContain(seen?.state);
        expect((await env.stores.operations.getObservation(a?.id ?? ''))?.state).toBe(
          'expired',
        );
      });
      // The proof walked the liteserver's chain to B itself, then asked the indexer for that
      // very transaction; the lying record is never a verdict.
      expect(
        asked.some((url) => hexOf(url.searchParams.get('hash')) === landed?.hash),
      ).toBe(true);
      // The lookup by hash is honest again, the listing still lies: B is proven through the
      // chain's own transaction.
      everywhere = false;
      const done = await env.mineWhile(rebuilt.wait({ finality: 'final' }));
      expect(done.status).toMatchObject({ state: 'final', txHash: landed?.hash });
      expect(done.operation?.activeAttempt?.id).toBe(b?.ref.id);
      expect([runsOf(env, a?.ref.id ?? ''), env.node.balance(FRESH), calls()]).toEqual([
        [],
        GRAM,
        2,
      ]);
    });

    // TON takes no `rejected` from a node's text: toncenter's refusals are unstructured,
    // so a refusal waits for the proven expiry, and a lone liar that relayed our bytes
    // cannot end the Operation.
    it("never ends an Operation on a lone endpoint's refusal of bytes it relayed", async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ signer });
      // The only endpoint relays our message, then answers a refusal of it.
      env.node.intercept = (_endpoint, route, request) => {
        if (route !== '/sendBocReturnHash') return undefined;
        try {
          env.node.submit(request.json<{ boc: string }>().boc);
        } catch {
          // Already taken or already run: the node's own answer does not matter here.
        }
        return { status: 400, json: { ok: false, error: SEQNO_REFUSAL, code: 400 } };
      };
      const intent = { to: FRESH_UQ, amount: GRAM };
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'lone' })),
      ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
      const record = await env.stores.operations.getByKey('default', 'lone');
      const attempt = record?.attempts[0];
      expect(record?.state).toBe('stalled');
      expect(await env.stores.operations.getObservation(attempt?.id ?? '')).toMatchObject(
        {
          state: 'refused',
          evidence: 'observed',
        },
      );
      // A caller's retry with the same key is answered from the store: nothing is signed.
      await expect(
        env.run(env.bc.transfer(intent, { idempotencyKey: 'lone' })),
      ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
      // The relayed bytes land: the refusal decided nothing, the proof ends it.
      const done = await env.mineWhile(
        env.bc.waitForConfirmation(record?.id ?? '', { finality: 'final' }),
      );
      expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect([
        runsOf(env, attempt?.ref.id ?? '').length,
        env.node.balance(FRESH),
      ]).toEqual([1, GRAM]);
      expect(calls()).toBe(1);
    });

    it("ends a refused message only by its proven expiry; the rebuild's refusal stalls, never expires", async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ signer });
      // The only endpoint refuses our valid message and never relays it.
      const refuse = (_endpoint: string, route: string) =>
        route === '/sendBocReturnHash'
          ? { status: 400, json: { ok: false, error: SEQNO_REFUSAL, code: 400 } }
          : undefined;
      env.node.intercept = refuse;
      await expect(
        env.run(
          env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'no' }),
        ),
      ).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
      const id = (await env.stores.operations.getByKey('default', 'no'))?.id ?? '';
      const { validUntil } = await orderingOf(env, id);
      let expiredAt: number | undefined;
      await monitorFor(env, PAST_LIFETIME, async () => {
        const state = (await recordOf(env, id)).state;
        if (state === 'expired') expiredAt ??= env.node.head;
        else expect(state).toBe('stalled');
      });
      // Proven at an attested block past the lifetime, never on the refusal.
      const attested = env.node.block((expiredAt as number) - FINALITY_SKEW);
      expect(attested?.shards[0]?.genUtime).toBeGreaterThanOrEqual(validUntil);
      await expect(env.run(env.bc.rebuild(id))).rejects.toMatchObject({
        code: 'NONCE_CONFLICT',
      });
      expect((await recordOf(env, id)).state).toBe('stalled');
      env.node.intercept = undefined;
      const resent = await env.run(env.bc.rebroadcast(id));
      const done = await env.mineWhile(resent.wait({ finality: 'final' }));
      const [original, rebuild] = (await recordOf(env, id)).attempts;
      expect(done.operation).toMatchObject({
        state: 'final',
        activeAttempt: { id: rebuild?.ref.id },
      });
      expect([
        runsOf(env, original?.ref.id ?? ''),
        env.node.balance(FRESH),
        calls(),
      ]).toEqual([[], GRAM, 2]);
    });
  });

  // Every resend path is guarded: a same-key retry, the `dropped` rebroadcast,
  // `recover()` and `bc.rebroadcast()`. Each could run our message again after a wallet
  // reset.
  describe('the replay guard before every send of stored bytes', () => {
    /** The external messages sent so far, an intercepted one included. */
    const sends = (env: Env) => sentBocs(env).length;
    const intent = { to: FRESH_UQ, amount: GRAM };
    const retry = (env: Env) =>
      env.run(env.bc.transfer(intent, { idempotencyKey: 'ours' }));

    /**
     * Our first send reaches the only endpoint, which relays it when `relay` and answers HTTP
     * 500 either way: ambiguous. `heal()` makes the endpoint honest again.
     */
    async function ambiguousSend(env: Env, relay: boolean) {
      env.node.intercept = (_endpoint, route, request) => {
        if (route !== '/sendBocReturnHash') return undefined;
        if (relay) {
          try {
            env.node.submit(request.json<{ boc: string }>().boc);
          } catch {
            // Already taken.
          }
        }
        return { status: 500, json: { ok: false, error: 'internal', code: 500 } };
      };
      await expect(retry(env)).rejects.toMatchObject({ ambiguous: true });
      const record = await env.stores.operations.getByKey('default', 'ours');
      const attempt = record?.attempts[0];
      return {
        operationId: record?.id ?? '',
        id: attempt?.ref.id ?? '',
        raw: attempt?.raw ?? { encoding: 'base64' as const, data: '' },
        heal: () => {
          env.node.intercept = undefined;
        },
      };
    }

    /** Software sharing the key deletes the wallet (+128+32), and a deposit re-funds it. */
    function reset(env: Env) {
      const now = Math.floor(env.clock.now() / 1000);
      env.node.submit(
        v4Request(1, now + VALID_FOR, [
          [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
        ]),
      );
      env.node.mine();
      expect(env.node.status(env.address)).toBe('uninitialized');
      env.node.inject(PAYER, env.address, 2n * GRAM, beginCell().endCell());
      env.node.mine();
    }

    // Two double pays with one signature, each reproduced end to end: our message lands,
    // the wallet is reset and re-funded within its lifetime, and a resend of the stored
    // bytes would run it again.
    it('never resends, on a caller retry after an ambiguous send, a message that ran into a reset', async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({
        version: 'v4r2',
        signer,
        lifecycle: { droppedGracePeriodMs: 120_000, rebroadcastIntervalMs: 60_000 },
      });
      // The endpoint relays our message, then its answer is lost (HTTP 500): ambiguous.
      let failing = true;
      env.node.intercept = (_endpoint, route, request) => {
        if (route !== '/sendBocReturnHash' || !failing) return undefined;
        try {
          env.node.submit(request.json<{ boc: string }>().boc);
        } catch {
          // Already taken.
        }
        return { status: 500, json: { ok: false, error: 'internal', code: 500 } };
      };
      await expect(
        env.run(
          env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'ours' }),
        ),
      ).rejects.toMatchObject({ ambiguous: true });
      const record = await env.stores.operations.getByKey('default', 'ours');
      const id = record?.attempts[0]?.ref.id ?? '';
      const now = () => Math.floor(env.clock.now() / 1000);
      env.node.mine(2);
      env.node.submit(
        v4Request(1, now() + VALID_FOR, [
          [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
        ]),
      );
      env.node.mine();
      env.node.inject(PAYER, env.address, 2n * GRAM, beginCell().endCell());
      env.node.mine();
      failing = false;
      // The caller retries with the same key, as an ambiguous error asks.
      await env
        .run(env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'ours' }))
        .catch(() => undefined);
      env.node.mine(2);
      expect(calls()).toBe(1);
      expect([runsOf(env, id).length, env.node.balance(FRESH)]).toEqual([1, GRAM]);
    });

    it('never resends a message that ran into a wallet reset and a refund within its lifetime', async () => {
      const { signer, calls } = countingSigner();
      // The indexer has not caught up with our transfer.
      const env = await createTonEnv({
        version: 'v4r2',
        signer,
        node: { indexerLag: 500 },
      });
      const sub = await env.run(
        env.bc.transfer({ to: FRESH_UQ, amount: GRAM }, { idempotencyKey: 'ours' }),
      );
      const id = sub.attempt?.id ?? '';
      const now = () => Math.floor(env.clock.now() / 1000);
      const passes = (blocks: number) => monitorFor(env, blocks, async () => undefined);
      await passes(2);
      expect([runsOf(env, id).length, env.node.balance(FRESH)]).toEqual([1, GRAM]);
      // Software sharing the key sends everything and deletes the wallet (+128+32) while our
      // message is still valid; the monitor keeps watching.
      env.node.submit(
        v4Request(1, now() + VALID_FOR, [
          [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
        ]),
      );
      await passes(15);
      // A deposit re-funds the deleted wallet: our deploy message (seqno 0, its StateInit)
      // is runnable again until it expires.
      env.node.inject(PAYER, env.address, 2n * GRAM, beginCell().endCell());
      await passes(15);
      expect(calls()).toBe(1);
      // Fund safety: the library never makes our message run twice.
      expect([runsOf(env, id).length, env.node.balance(FRESH)]).toEqual([1, GRAM]);
      // The monitor's dropped rebroadcasts asked the chain first, and withheld the bytes.
      expect(env.warnings).toContain('RESEND_WITHHELD');
    });

    it('never resends through recover() after a reset (a new process: the widest window)', async () => {
      const env = await createTonEnv({ version: 'v4r2' });
      const ours = await ambiguousSend(env, true);
      env.node.mine(2);
      expect(runsOf(env, ours.id)).toHaveLength(1);
      reset(env);
      ours.heal();
      const before = sends(env);
      const restarted = env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ failed: 0 });
      env.node.mine(2);
      expect([sends(env) - before, runsOf(env, ours.id).length]).toEqual([0, 1]);
      expect(env.node.balance(FRESH)).toBe(GRAM);
      expect(env.warnings).toContain('RESEND_WITHHELD');
    });

    it('never resends through bc.rebroadcast() or a bare broadcast after a reset', async () => {
      const env = await createTonEnv({ version: 'v4r2' });
      const ours = await ambiguousSend(env, true);
      env.node.mine(2);
      reset(env);
      ours.heal();
      const before = sends(env);
      await expect(env.run(env.bc.rebroadcast(ours.operationId))).rejects.toMatchObject({
        ambiguous: true,
        retryable: true,
      });
      // A bare broadcast of the same bytes is guarded too (no record: the widest window).
      await expect(env.run(env.bc.broadcast(ours.raw))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      env.node.mine(2);
      expect([sends(env) - before, runsOf(env, ours.id).length]).toEqual([0, 1]);
      expect(env.node.balance(FRESH)).toBe(GRAM);
    });

    it('finds our message in the part of the chain the attested head does not reach yet: already known, never sent', async () => {
      const env = await createTonEnv({ version: 'v4r2' });
      const ours = await ambiguousSend(env, true);
      env.node.mine(2);
      // The same key's software destroys the wallet; extra currencies keep the account, so
      // its chain goes on, uninitialized: our seqno-0 deploy message could run again.
      env.node.holdExtraCurrency(env.address);
      env.node.submit(
        v4Request(1, Math.floor(env.clock.now() / 1000) + VALID_FOR, [
          [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
        ]),
      );
      env.node.mine();
      expect(env.node.status(env.address)).toBe('uninitialized');
      ours.heal();
      const before = sends(env);
      // All of it is younger than the attested head (it trails by the skew): only the walk
      // from the freshest state sees our run, behind the destruction.
      const sub = await retry(env);
      expect(sub.state).toBe('submitted');
      expect([sends(env) - before, runsOf(env, ours.id).length]).toEqual([0, 1]);
    });

    it("resends a new wallet's message minutes after its funding: a chain start whose code never ran", async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ fund: 0n, signer });
      env.node.inject(PAYER, env.address, 5n * GRAM, beginCell().endCell());
      env.node.mine();
      // The first send is lost on the way; the monitor rebroadcasts the dropped bytes.
      env.node.swallow = true;
      const sub = await env.run(env.bc.transfer(intent));
      env.node.swallow = false;
      const id = sub.attempt?.id ?? '';
      const done = await env.mineWhile(sub.wait({ finality: 'final' }), 60);
      expect(done.status.state).toBe('final');
      expect([env.node.sendCount(id), runsOf(env, id).length, calls()]).toEqual([
        2, 1, 1,
      ]);
    });

    it('never sends while the walk cannot finish: a 429 in its middle', async () => {
      const env = await createTonEnv({ fund: 0n });
      // More wallet transactions inside the window than one page holds.
      for (let i = 0; i < 40; i++) {
        env.node.inject(PAYER, env.address, GRAM / 4n, beginCell().endCell());
      }
      env.node.mine();
      const ours = await ambiguousSend(env, false);
      let pages = 0;
      env.node.intercept = (_endpoint, route) => {
        if (route !== '/getTransactions') return undefined;
        pages += 1;
        return pages === 1
          ? undefined
          : { status: 429, json: { ok: false, error: 'Ratelimit exceed', code: 429 } };
      };
      const before = sends(env);
      await expect(retry(env)).rejects.toMatchObject({
        ambiguous: true,
        retryable: true,
      });
      expect([pages > 1, sends(env) - before]).toEqual([true, 0]);
      ours.heal();
      await env.clock.advance(20_000);
      const sub = await retry(env);
      expect(sends(env) - before).toBe(1);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      expect(runsOf(env, ours.id)).toHaveLength(1);
    });

    it('walks back only to the recorded build time, and each authenticated transaction once; a new process takes the widest window', async () => {
      const env = await createTonEnv({ fund: 0n });
      for (let i = 0; i < 40; i++) {
        env.node.inject(PAYER, env.address, GRAM / 4n, beginCell().endCell());
      }
      env.node.mine();
      // The deposits are older than any message built from now on, less the tolerance.
      await env.clock.advance((CHAIN_TIME_TOLERANCE + 100) * 1_000);
      env.node.mine();
      const ours = await ambiguousSend(env, false);
      const walked = async (send: () => Promise<unknown>) => {
        const from = env.node.served.length;
        await send().catch(() => undefined);
        return servedSince(env, from).filter((route) => route === '/getTransactions')
          .length;
      };
      // This process assembled the bytes: the walk stops at their recorded start (one page),
      // and a second guard reads nothing it has authenticated already.
      expect(await walked(() => retry(env))).toBe(1);
      expect(await walked(() => retry(env))).toBe(0);
      // Another process has no record: the widest lifetime, so the whole history (2 pages).
      const restarted = env.restart({ killPrevious: true });
      expect(
        await walked(() =>
          env.run(restarted.bc.transfer(intent, { idempotencyKey: 'ours' })),
        ),
      ).toBe(2);
      expect(runsOf(env, ours.id)).toHaveLength(0);
    });

    it("skips the walk once the wallet's seqno is past ours: the message cannot run", async () => {
      const env = await createTonEnv();
      const ours = await ambiguousSend(env, true);
      env.node.mine(2);
      expect(env.node.seqno(env.address)).toBe(1);
      ours.heal();
      const from = env.node.served.length;
      await retry(env).catch(() => undefined);
      expect(servedSince(env, from)).not.toContain('/getTransactions');
      expect(runsOf(env, ours.id)).toHaveLength(1);
    });

    // The first-send skip holds only within 2 s of `assemble`, so a first send that
    // stalled past the address lease is guarded too: with a shared store, another
    // container may have sent the bytes meanwhile.
    it('guards a first send that comes more than 2 s after assemble: a shared store, a lapsed lease and a reset', async () => {
      const { signer, calls } = countingSigner();
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      // Container A's appendAttempt commits, then A stalls (a slow store, a paused
      // process) before its first send, past the 30 s address lease.
      const env = await createTonEnv({
        version: 'v4r2',
        signer,
        stores: (clock) => {
          const operations = new MemoryOperationStore(clock);
          const append = operations.appendAttempt.bind(operations);
          operations.appendAttempt = async (...args) => {
            const record = await append(...args);
            if (!paused) {
              paused = true;
              await gate;
            }
            return record;
          };
          return { operations };
        },
      });
      const a = env.bc.transfer(intent, { idempotencyKey: 'ours' });
      a.catch(() => undefined);
      await env.clock.advance(31_000);
      env.node.mine();
      expect(paused).toBe(true);
      // Container B, over the same store, recovers the Operation: it has no record of the
      // bytes, so it guards them, finds that nothing ran, and sends.
      await env.run(env.restart().aio.operations.recover());
      const id =
        (await env.stores.operations.getByKey('default', 'ours'))?.attempts[0]?.ref.id ??
        '';
      env.node.mine(2);
      expect([runsOf(env, id).length, env.node.balance(FRESH)]).toEqual([1, GRAM]);
      // Software sharing the key deletes the wallet and a deposit re-funds it: our message
      // could run again while it is valid.
      reset(env);
      // A resumes. Its first send comes 31 s after assemble, so the guard runs and
      // withholds the bytes.
      release();
      await env.run(a).catch(() => undefined);
      env.node.mine(2);
      expect(calls()).toBe(1);
      expect([runsOf(env, id).length, env.node.balance(FRESH)]).toEqual([1, GRAM]);
      expect(env.warnings).toContain('RESEND_WITHHELD');
    });
  });

  it('moves jettons to final, with the memo in the notification', async () => {
    const env = await createTonEnv();
    env.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    env.node.mintJetton(MASTER, env.address, 1_000_000n);
    const jetton = { standard: 'jetton', contract: MASTER };
    const fee = await env.run(
      env.bc.estimateFee({ to: FRESH_UQ, amount: '0.4', asset: jetton }),
    );
    expect(fee).toMatchObject({ kind: 'ton', bound: 'upper' });
    const sub = await env.run(
      env.bc.transfer({ to: FRESH_UQ, amount: '0.4', asset: jetton, memo: 'order 9' }),
    );
    await env.mineWhile(sub.wait({ finality: 'final' }));
    expect(env.node.jettonBalance(MASTER, FRESH)).toBe(400_000n);
    expect(env.node.jettonBalance(MASTER, env.address)).toBe(600_000n);
  });

  describe('a jetton wallet that gives no answer decides nothing', () => {
    /** Every endpoint answers `get_wallet_data` for `wallet` with exit -13 ("no state"). */
    const noState = (env: Env, wallet: string, exitCode = -13) => {
      env.node.intercept = (_e, route, request) => {
        if (route !== '/runGetMethod') return undefined;
        const body = request.json<{ method: string; address: string }>();
        return body.method === 'get_wallet_data' && body.address === wallet
          ? { json: { ok: true, result: { exit_code: exitCode, stack: [] } } }
          : undefined;
      };
    };
    const jettonEnv = async () => {
      const { signer, calls } = countingSigner();
      const env = await createTonEnv({ signer });
      env.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
      env.node.mintJetton(MASTER, env.address, 1_000_000n);
      return { env, calls };
    };
    const asset = { standard: 'jetton', contract: MASTER };

    it('keeps a delivered jetton transfer undecided, never failed, then proves it final', async () => {
      for (const side of ['recipient', 'sender'] as const) {
        const { env, calls } = await jettonEnv();
        const wallet = env.node.jettonWalletOf(
          MASTER,
          side === 'sender' ? env.address : FRESH,
        );
        const sub = await env.run(
          env.bc.transfer({ to: FRESH_UQ, amount: 400_000n, asset }),
        );
        noState(env, wallet);
        await monitorFor(env, 20, async () => {
          const record = await recordOf(env, sub.operationId);
          expect(['submitted', 'included']).toContain(record.state);
        });
        expect(env.warnings).toContain('JETTON_UNVERIFIED');
        env.node.intercept = undefined;
        const done = await env.mineWhile(sub.wait({ finality: 'final' }));
        expect(done.status).toMatchObject({ state: 'final', evidence: 'proven' });
        expect([env.node.jettonBalance(MASTER, FRESH), calls()]).toEqual([400_000n, 1]);
      }
    });

    it('never drops a jetton deposit from history on "no state" for its jetton wallet; a fake contract never stalls it', async () => {
      const { env } = await jettonEnv();
      const sub = await env.run(
        env.bc.transfer({ to: FRESH_UQ, amount: 400_000n, asset }),
      );
      await env.mineWhile(sub.wait({ finality: 'final' }));
      const wallet = env.node.jettonWalletOf(MASTER, FRESH);
      // Another process: nothing verified yet (the proof's verification is kept per driver).
      const { bc } = env.restart();
      const arrivals = async () =>
        (await env.run(bc.history(wallet))).items.flatMap((tx) =>
          tx.transfers.filter((t) => t.id.endsWith(':msg:in:jetton')),
        );
      // The arrival's own jetton wallet ran at that block: "no state" there is unavailable.
      noState(env, wallet);
      await expect(env.run(bc.history(wallet))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      // Any other exit code reads as "not a jetton wallet": the page reads, `partial`.
      noState(env, wallet, 11);
      const page = await env.run(bc.history(wallet));
      expect(page.items.some((tx) => tx.decoding === 'partial')).toBe(true);
      // The owner's notification names its sender, which ran earlier: never a stall either.
      noState(env, wallet);
      const owner = await env.run(bc.history(FRESH));
      expect(owner.items.length).toBeGreaterThan(0);
      env.node.intercept = undefined;
      expect(await arrivals()).toHaveLength(1);
    });
  });

  describe('a junk jetton never stalls deposit history', () => {
    const JUNK = `0:${'88'.repeat(32)}`;
    /** A genuine 1 GRAM deposit to FRESH, then 7 base units of a junk jetton. */
    async function junkDeposit(jetton: { readonly symbol?: string }) {
      const env = await createTonEnv({ version: 'v4r2' });
      env.node.deployJetton(JUNK, { ...jetton, content: 'offchain' });
      env.node.mintJetton(JUNK, env.address, 1_000n);
      env.node.inject(PAYER, FRESH, GRAM, beginCell().endCell());
      env.node.mine(2);
      const { boc } = await signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil: Math.floor(env.clock.now() / 1000) + 60,
        deploy: true,
        messages: [
          jettonMessage({
            jettonWallet: env.node.jettonWalletOf(JUNK, env.address),
            attached: 50_000_000n,
            queryId: 0n,
            amount: 7n,
            destination: FRESH,
            responseDestination: env.address,
            forwardAmount: 1n,
          }),
        ],
      });
      env.node.submit(boc);
      env.node.mine(11);
      await env.clock.advance(5_000);
      return env;
    }
    const transfersOf = async (env: Env, bc: Env['bc']) =>
      (await env.run(bc.history(FRESH))).items.flatMap((tx) => tx.transfers);

    for (const [name, jetton] of [
      ['never indexed', {}],
      ['indexed without decimals', { symbol: 'JUNK' }],
    ] as const) {
      it(`reads the page with the junk transfer raw and unresolved: metadata ${name}`, async () => {
        const env = await junkDeposit(jetton);
        for (let i = 0; i < 3; i++) {
          const transfers = await transfersOf(env, env.bc);
          // The genuine deposit is there, and so is the junk one, in base units, unresolved.
          expect(transfers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                amount: expect.objectContaining({ base: GRAM }),
              }),
              expect.objectContaining({
                unresolved: {
                  asset: { standard: 'jetton', contract: JUNK },
                  amount: 7n,
                  code: 'PROVIDER_UNAVAILABLE',
                },
              }),
            ]),
          );
          env.node.mine(5);
          await env.clock.advance(5_000);
        }
        // Nothing was cached: once the indexer has usable metadata, a read resolves it.
        env.node.deployJetton(JUNK, { symbol: 'JUNK', decimals: 2, content: 'offchain' });
        env.node.mine(2);
        const resolved = (await transfersOf(env, env.bc)).find((t) =>
          t.id.endsWith(':msg:in:jetton'),
        );
        expect(resolved).toMatchObject({ amount: { base: 7n } });
        expect(resolved?.unresolved).toBeUndefined();
      });
    }
  });

  it("reports one jetton deposit twice: the jetton wallet's arrival, which is credited, and the owner's notification", async () => {
    const env = await createTonEnv();
    env.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    env.node.mintJetton(MASTER, env.address, 1_000_000n);
    const sub = await env.run(
      env.bc.transfer({
        to: FRESH_UQ,
        amount: 400_000n,
        asset: { standard: 'jetton', contract: MASTER },
        memo: 'order 9',
      }),
    );
    await env.mineWhile(sub.wait({ finality: 'final' }));
    const jettonDeposits = async (address: string) =>
      (await env.run(env.bc.history(address))).items.flatMap((tx) =>
        tx.transfers
          .filter((t) => t.id.endsWith(':msg:in:jetton'))
          .map((t) => ({
            id: t.id,
            tx: tx.id,
            traceId: tx.details.traceId,
            to: t.to.canonical,
            amount: t.amount?.base,
            memo: t.memo,
          })),
      );
    const wallet = await env.run(env.bc.ext.ton.jettonWallet(FRESH_UQ, MASTER));
    expect(wallet).toBe(env.node.jettonWalletOf(MASTER, FRESH));
    const [arrival, ...moreArrivals] = await jettonDeposits(wallet);
    const [notification, ...moreNotifications] = await jettonDeposits(FRESH);
    expect([moreArrivals, moreNotifications]).toEqual([[], []]);
    // The same movement, twice: different transfer ids, one trace. Credit only the arrival,
    // on the owner's jetton wallet; it names the owner as `to` and carries the memo.
    expect(arrival).toMatchObject({ to: FRESH, amount: 400_000n, memo: 'order 9' });
    expect(notification).toMatchObject({ to: FRESH, amount: 400_000n, memo: 'order 9' });
    expect(arrival?.id).not.toBe(notification?.id);
    expect(arrival?.tx).not.toBe(notification?.tx);
    expect(arrival?.traceId).toBe(notification?.traceId);
  });

  it('reads each block header and verifies each jetton wallet once per history page', async () => {
    const env = await createTonEnv();
    env.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    env.node.mintJetton(MASTER, env.address, 1_000_000n);
    const asset = { standard: 'jetton', contract: MASTER };
    for (let i = 0; i < 3; i++) {
      const sub = await env.run(env.bc.transfer({ to: FRESH_UQ, amount: 1_000n, asset }));
      await env.mineWhile(sub.wait({ finality: 'final' }));
    }
    const wallet = env.node.jettonWalletOf(MASTER, FRESH);
    // Another process: nothing verified yet.
    const { bc } = env.restart();
    const from = env.node.fetch.calls.length;
    const page = await env.run(bc.history(wallet));
    const calls = env.node.fetch.calls.slice(from);
    const arrivals = page.items.filter((tx) =>
      tx.transfers.some((t) => t.id.endsWith(':msg:in:jetton')),
    );
    expect(arrivals).toHaveLength(3);
    const blocks = new Set(page.items.map((tx) => tx.block?.height));
    const headers = calls.filter((call) =>
      new URL(call.url).pathname.endsWith('/getBlockHeader'),
    );
    const walletData = calls.filter(
      (call) =>
        new URL(call.url).pathname.endsWith('/runGetMethod') &&
        (JSON.parse(call.body ?? '{}') as { method?: string }).method ===
          'get_wallet_data',
    );
    expect(headers).toHaveLength(blocks.size);
    expect(walletData).toHaveLength(1);
    // Three deposits in one block: one header read for them.
    for (let i = 0; i < 3; i++)
      env.node.inject(PAYER, SMALL, GRAM, beginCell().endCell());
    env.node.mine(2);
    const before = env.node.fetch.calls.length;
    const deposits = await env.run(bc.history(SMALL));
    expect(deposits.items).toHaveLength(3);
    const reads = env.node.fetch.calls
      .slice(before)
      .filter((call) => new URL(call.url).pathname.endsWith('/getBlockHeader'));
    expect(reads).toHaveLength(1);
  });

  it("fails a jetton transfer the recipient's jetton wallet bounced", async () => {
    const env = await createTonEnv();
    env.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    env.node.mintJetton(MASTER, env.address, 1_000_000n);
    env.node.failJettonWallet(env.node.jettonWalletOf(MASTER, FRESH));
    const sub = await env.run(
      env.bc.transfer({
        to: FRESH_UQ,
        amount: 400_000n,
        asset: { standard: 'jetton', contract: MASTER },
      }),
    );
    await expect(env.mineWhile(sub.wait({ finality: 'final' }))).rejects.toMatchObject({
      code: 'TX_REVERTED',
    });
    expect(await env.run(env.bc.getTransactionStatus(sub.operationId))).toMatchObject({
      state: 'failed',
      evidence: 'proven',
      reason: REASONS.jettonBounced,
    });
    expect(env.node.jettonBalance(MASTER, env.address)).toBe(1_000_000n);
    expect(env.node.jettonBalance(MASTER, FRESH)).toBe(0n);
  });

  describe('crash and recovery (restart({ killPrevious: true }))', () => {
    function crashEnv() {
      const { signer, calls } = countingSigner();
      let faulty: FaultyOperationStore | undefined;
      const env = createTonEnv({
        signer,
        stores: (clock) => {
          faulty = new FaultyOperationStore(new MemoryOperationStore(clock));
          return { operations: faulty };
        },
      });
      return env.then((ready) => ({
        env: ready,
        faulty: faulty as FaultyOperationStore,
        calls,
      }));
    }
    const patchState = (state: string) => (args: readonly unknown[]) =>
      (args[2] as OperationPatch | undefined)?.state === state;

    /**
     * Signed once, paid once: the Operation is final with its one Attempt the winner, and
     * the message the chain ran is the one stored, the bytes every send carried.
     */
    async function finalOnce(env: Env, calls: () => number, key: string) {
      const record = await env.stores.operations.getByKey('default', key);
      const [attempt] = record?.attempts ?? [];
      const runs = runsOf(env, attempt?.ref.id ?? '');
      expect(record).toMatchObject({
        state: 'final',
        outcome: 'executed',
        activeAttemptId: attempt?.id,
      });
      expect(record?.attempts).toHaveLength(1);
      expect(await env.stores.operations.getObservation(attempt?.id ?? '')).toMatchObject(
        { state: 'final', evidence: 'proven', txHash: runs[0]?.hash },
      );
      expect(new Set(sentBocs(env))).toEqual(new Set([attempt?.raw.data]));
      expect([runs.length, env.node.balance(FRESH), calls()]).toEqual([1, 3n, 1]);
    }

    it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
      await expect(
        env.run(env.bc.transfer({ to: FRESH_UQ, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.sendCount(ref)]).toEqual(['signed', 0]);
      const restarted = env.restart({ killPrevious: true });
      // The crashed process is dead: nothing on its handle settles any more.
      let oldSettled = false;
      void env.bc.getBlockHeight().then(
        () => (oldSettled = true),
        () => (oldSettled = true),
      );
      const sub = await env.run(
        restarted.bc.transfer({ to: FRESH_UQ, amount: 3n }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
      await env.mineWhile(sub.wait({ finality: 'final' }));
      await finalOnce(env, calls, 'k');
      expect(oldSettled).toBe(false);
    });

    it('recovers a broadcast that was never recorded, and finalizes it', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({
        method: 'update',
        timing: 'before',
        when: patchState('submitted'),
      });
      await expect(
        env.run(env.bc.transfer({ to: FRESH_UQ, amount: 3n }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.sendCount(ref)]).toEqual(['signed', 1]);
      const restarted = env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      expect(env.node.sendCount(ref)).toBe(2);
      const sub = await env.run(
        restarted.bc.transfer({ to: FRESH_UQ, amount: 3n }, { idempotencyKey: 'k' }),
      );
      await env.mineWhile(sub.wait({ finality: 'final' }));
      await finalOnce(env, calls, 'k');
    });
  });
});
