import { ed25519 } from '@noble/curves/ed25519';
import {
  Cell,
  SendMode,
  beginCell,
  external,
  loadMessage,
  loadTransaction,
  storeMessage,
  storeMessageRelaxed,
  storeTransaction,
  type MessageRelaxed,
} from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import {
  addressArgument,
  jettonMessage,
  nativeMessage,
} from '../../../src/adapters/ton/messages';
import {
  CONSUMER_PAGES,
  WALK_PAGES,
  createTonHistory,
  createTonProofs,
  replayVerdict,
} from '../../../src/adapters/ton/proofs';
import { REASONS } from '../../../src/adapters/ton/trace';
import { normalizedHash } from '../../../src/adapters/ton/wallets';
import { CHAIN_TIME_TOLERANCE } from '../../../src/adapters/ton/builder';
import type { TonSeqnoOrdering } from '../../../src/adapters/ton/types';
import type { OrderingData } from '../../../src/core/model/ordering';
import type { AttemptRef } from '../../../src/core/model/transaction';
import type { FakeRequest } from '../../../src/testing/fake-fetch';
import { tonHarness } from './support/context';
import { relayedBody, signedBoc, testWallet } from './support/harness';
import { KEY, PUBLIC_KEY } from './support/vectors';

/** The built-in networks' `params.finalitySkewBlocks`. */
const FINALITY_SKEW = 10;

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const FRESH = `0:${'11'.repeat(32)}`;
const PAYER = `0:${'33'.repeat(32)}`;
const ZERO_HASH = Buffer.alloc(32).toString('base64');
/**
 * Earlier rows the code-never-ran rule refuses: the code ran, or no statuses. Below a
 * chain start inside the window, an earlier incarnation whose code never ran cannot hold
 * our transfer; any other row decides nothing.
 */
const CODE_RAN: readonly Record<string, unknown>[] = [
  {
    description: {
      type: 'ord',
      aborted: false,
      compute_ph: { skipped: false, success: true, exit_code: 0 },
      action: {
        success: true,
        valid: true,
        no_funds: false,
        result_code: 0,
        tot_actions: 0,
        skipped_actions: 0,
        msgs_created: 0,
      },
    },
  },
  { end_status: 'active' },
  { orig_status: 'frozen', end_status: 'frozen' },
  { orig_status: undefined },
];
const ref = (id: string): AttemptRef => ({
  id,
  idKind: 'message-hash',
  canonical: false,
});

type Harness = ReturnType<typeof tonHarness>;
type Json = Record<string, unknown>;

function setup(options: Parameters<typeof tonHarness>[0] = {}) {
  const h = tonHarness(options);
  const proofs = createTonProofs(h.ctx);
  const from = testWallet('v4r2', TESTNET);
  h.node.fund(from, 5n * GRAM);
  const now = () => Math.floor(h.clock.now() / 1000);
  /** A signed request for seqno 0 from the test wallet; not sent. */
  const request = async (messages: MessageRelaxed[], validFor = 60) => {
    const validUntil = now() + validFor;
    const signed = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages,
    });
    // As the builder records it: the lifetime, and the chain time it began.
    const ordering: TonSeqnoOrdering = {
      kind: 'seqno',
      seqno: 0n,
      validUntil,
      validFrom: now(),
    };
    return { ...signed, ordering };
  };
  const pay = (bounce = false) =>
    request([nativeMessage({ to: FRESH, value: GRAM, bounce })]);
  /** Advances chain time one second per masterchain block. */
  const tick = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      await h.clock.advance(1_000);
      h.node.mine();
    }
  };
  return { h, proofs, from, request, pay, now, tick };
}

/**
 * Where `match` holds, the node's own answer (read past this intercept) as `edit` makes it;
 * `retarget` makes the node answer another request (another block, another shard).
 */
function rewrite(
  h: Harness,
  match: (endpoint: string, route: string, request: FakeRequest) => boolean,
  edit: (json: Json, request: FakeRequest) => Json,
  retarget: (url: URL) => void = () => undefined,
): void {
  let inner = false;
  h.node.intercept = (endpoint, route, request) => {
    if (inner || !match(endpoint, route, request)) return undefined;
    inner = true;
    return (async () => {
      try {
        const url = new URL(request.url.href);
        retarget(url);
        const response = await h.node.fetch.fetch(url.href, {
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
        return {
          status: response.status,
          json: edit((await response.json()) as Json, request),
        };
      } finally {
        inner = false;
      }
    })();
  };
}

/** The indexer's hash lookup misses (a race, or no normalized-hash lookup). */
const hideLookups = (h: Harness) => {
  h.node.intercept = (_endpoint, route) =>
    route === '/transactionsByMessage'
      ? { json: { transactions: [], address_book: {} } }
      : undefined;
};

/**
 * A v4r2 request from the test key's wallet, deploying it, with each message's own send
 * mode: our builder always sends mode 3, the same key's other software need not.
 */
function v4Request(
  seqno: number,
  validUntil: number,
  messages: readonly (readonly [number, MessageRelaxed])[],
): { readonly boc: string; readonly hashNorm: string } {
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
  const message = beginCell()
    .store(storeMessage(external({ to: contract.address, body, ...init })))
    .endCell();
  return {
    boc: message.toBoc().toString('base64'),
    hashNorm: Buffer.from(normalizedHash(message)).toString('hex'),
  };
}

// Each fact is attested at its own height, with a monotone predicate or at a fixed block.
// Only the unanchored head trails one endpoint's head by a skew, and a quorum read of
// that block attests it.
describe('TON proofs', () => {
  it('attests an unanchored head trailed by the skew', async () => {
    const s = setup({ endpoints: ['a', 'b'] });
    s.h.node.mine(FINALITY_SKEW + 5);
    const head = s.h.node.head;
    s.h.node.lagEndpoint('b', 3);
    const attested = await s.h.run(s.proofs.finalizedHead());
    expect(attested).toEqual({
      height: BigInt(head - FINALITY_SKEW),
      hash: s.h.node.block(head - FINALITY_SKEW)?.rootHash,
      timestamp: s.h.node.block(head - FINALITY_SKEW)?.genUtime,
    });
    s.h.node.intercept = (endpoint, route) =>
      endpoint === 'b' && route === '/getBlockHeader'
        ? {
            json: {
              ok: true,
              result: {
                id: {
                  workchain: -1,
                  shard: '-9223372036854775808',
                  seqno: head - FINALITY_SKEW,
                  root_hash: 'A'.repeat(43) + '=',
                  file_hash: 'A'.repeat(43) + '=',
                },
                global_id: -3,
                gen_utime: 1,
              },
            },
          }
        : undefined;
    await expect(s.h.run(s.proofs.finalizedHead())).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('attests a consumed seqno with a monotone predicate; a lagging peer decides nothing', async () => {
    const s = setup({ endpoints: ['a', 'b'] });
    const { boc, ordering } = await s.pay();
    expect(await s.h.run(s.proofs.slotConsumed(ordering, s.from, 'finalized'))).toBe(
      false,
    );
    s.h.node.submit(boc);
    s.h.node.mine();
    // TON gives no separate `latest` evidence, so no observed `replaced` ever.
    expect(await s.h.run(s.proofs.slotConsumed(ordering, s.from, 'latest'))).toBe(false);
    expect(await s.h.run(s.proofs.slotConsumed(ordering, s.from, 'finalized'))).toBe(
      true,
    );
    s.h.node.lagEndpoint('b', 1);
    await expect(
      s.h.run(s.proofs.slotConsumed(ordering, s.from, 'finalized')),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect(
      await s.h.run(
        s.proofs.slotConsumed({ kind: 'nonce', nonce: 0n }, s.from, 'finalized'),
      ),
    ).toBe(false);
  });

  it('proves an included transfer once its trace completes, and a bounce as failed', async () => {
    const s = setup();
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.mine();
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    s.h.node.mine();
    const proof = await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from));
    expect(proof).toMatchObject({
      included: true,
      success: true,
      blockHeight: 2n,
      blockHash: s.h.node.block(2)?.rootHash,
    });
    const bounced = setup();
    const b = await bounced.pay(true);
    bounced.h.node.submit(b.boc);
    bounced.h.node.mine(3);
    expect(
      await bounced.h.run(
        bounced.proofs.includedFinal(ref(b.hashNorm), b.ordering, bounced.from),
      ),
    ).toMatchObject({ included: true, success: false, reason: REASONS.bounced });
  });

  // The liteserver shows the seqno consumed while the indexer has not indexed the
  // transaction yet: the Attempt stays undecided, never `replaced`.
  it('decides nothing while the indexer lags behind the consumed seqno', async () => {
    const s = setup({ node: { indexerLag: 40 } });
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.mine(FINALITY_SKEW + 5);
    expect(await s.h.run(s.proofs.slotConsumed(ordering, s.from, 'finalized'))).toBe(
      true,
    );
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    s.h.node.indexerLag = 0;
    expect(
      await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).toMatchObject({ included: true, success: true });
  });

  it('proves "not included" when another message consumed the seqno', async () => {
    const s = setup();
    const ours = await s.pay();
    const theirs = await s.request([
      nativeMessage({ to: FRESH, value: 7n, bounce: false }),
    ]);
    s.h.node.submit(theirs.boc);
    s.h.node.mine(FINALITY_SKEW + 3);
    // Never while ours may still run (a reset could bring the seqno back).
    await expect(
      s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    await s.tick(80);
    expect(
      await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
    ).toEqual({ included: false });
  });

  // A shard block older than the masterchain's time can still include the message.
  it('proves expiry only once every shard is past valid_until', async () => {
    const s = setup({ node: { shardLagSeconds: 30 } });
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.dropPending();
    await s.tick(75);
    // Masterchain time is past valid_until; the shard is 30 s behind it.
    expect(s.h.node.block(s.h.node.head - FINALITY_SKEW)!.genUtime).toBeGreaterThan(
      ordering.validUntil,
    );
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(false);
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await s.tick(40);
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(true);
    expect(
      await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).toEqual({
      included: false,
    });
  });

  it('retries the attested head at the lag tolerance when a peer trails further', async () => {
    const s = setup({
      endpoints: ['a', 'b'],
      maxLagBlocks: 150,
      node: { shardLagSeconds: 1 },
    });
    const { boc, hashNorm, ordering } = await s.pay();
    void boc; // never sent: the chain never sees it
    await s.tick(260);
    s.h.node.lagEndpoint('b', 40);
    // head − 10 is not on `b` yet; head − 150 is on both, and past valid_until everywhere.
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(true);
    expect(
      await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).toEqual({
      included: false,
    });
  });

  // `expired` gets no address, so it cannot pick the wallet's own shard: it takes the
  // oldest time of every shard top the attested block commits.
  it('proves expiry only once the slowest of two shards is past valid_until', async () => {
    const s = setup({
      node: { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 40 },
    });
    const { ordering } = await s.pay();
    await s.tick(90);
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(false);
    await s.tick(20);
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(true);
  });

  it('never reads a frozen wallet as seqno 0', async () => {
    const s = setup();
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.mine(FINALITY_SKEW + 3);
    s.h.node.freeze(s.from);
    s.h.node.indexerLag = 30;
    s.h.node.mine(FINALITY_SKEW + 3);
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('never reads a frozen wallet as seqno 0, even once the message has expired', async () => {
    const s = setup();
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.mine(FINALITY_SKEW + 3);
    s.h.node.freeze(s.from);
    s.h.node.indexerLag = 200;
    await s.tick(80);
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it("decides only once the endpoints hold the trace's last block", async () => {
    const s = setup();
    const { boc, hashNorm, ordering } = await s.pay();
    s.h.node.submit(boc);
    s.h.node.mine(2);
    // The indexer has the whole trace; the liteserver is a block behind its delivery.
    s.h.node.lagEndpoint('main', 1);
    await expect(
      s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    s.h.node.lagEndpoint('main', 0);
    expect(
      await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
    ).toMatchObject({ included: true, success: true });
  });

  it("confirms a jetton transfer's wallets under the proof quorum, at the trace's last block", async () => {
    const MASTER = `0:${'77'.repeat(32)}`;
    const h = tonHarness({ endpoints: ['a', 'b'] });
    const proofs = createTonProofs(h.ctx);
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const validUntil = Math.floor(h.clock.now() / 1000) + 60;
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages: [
        jettonMessage({
          jettonWallet: h.node.jettonWalletOf(MASTER, sender),
          attached: 50_000_000n,
          queryId: 0n,
          amount: 400n,
          destination: FRESH,
          responseDestination: sender,
          forwardAmount: 1n,
        }),
      ],
    });
    h.node.submit(boc);
    h.node.mine(5);
    const ordering = { kind: 'seqno' as const, seqno: 0n, validUntil };
    // Endpoint `b`'s master names another wallet for the recipient: no verdict.
    h.node.intercept = (endpoint, route, request) =>
      endpoint === 'b' &&
      route === '/runGetMethod' &&
      request.json<{ method: string }>().method === 'get_wallet_address' &&
      request.json<{ address: string }>().address === MASTER &&
      !request.body?.includes(addressArgument(sender))
        ? {
            json: {
              ok: true,
              result: {
                exit_code: 0,
                stack: [['cell', { bytes: addressArgument(`0:${'66'.repeat(32)}`) }]],
              },
            },
          }
        : undefined;
    await expect(
      h.run(proofs.includedFinal(ref(hashNorm), ordering, sender)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    // Both agree now; every jetton get-method runs at the trace's last block.
    const blocks: [string, number | undefined][] = [];
    h.node.intercept = (_endpoint, route, request) => {
      if (route === '/runGetMethod') {
        const { method, seqno } = request.json<{ method: string; seqno?: number }>();
        blocks.push([method, seqno]);
      }
      return undefined;
    };
    expect(
      await h.run(proofs.includedFinal(ref(hashNorm), ordering, sender)),
    ).toMatchObject({ included: true, success: true });
    const last = Math.max(...h.node.transactions().map((tx) => tx.mcSeqno));
    expect(last).toBeLessThan(h.node.head);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(([, seqno]) => seqno === last)).toBe(true);
  });

  describe('a lying first endpoint decides nothing', () => {
    it('flips a delivered transfer into a bounce: no verdict', async () => {
      const s = setup({ endpoints: ['a', 'b'] });
      const { boc, hashNorm, ordering } = await s.pay();
      s.h.node.submit(boc);
      s.h.node.mine(3);
      s.h.node.intercept = (endpoint, route, request) => {
        if (endpoint !== 'a' || route !== '/traces') return undefined;
        return s.h.node.fetch
          .fetch(request.url.href.replace('://a.', '://b.'))
          .then(async (response) => {
            const body = (await response.json()) as {
              traces: {
                transactions: Record<string, { description: Record<string, unknown> }>;
              }[];
            };
            for (const tx of Object.values(body.traces[0]!.transactions)) {
              tx.description = {
                ...tx.description,
                aborted: true,
                bounce: { type: 'ok' },
              };
            }
            return { json: body };
          });
      };
      await expect(
        s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    });

    it('swaps the consumer body under its keyed hash: never a proven "replaced"', async () => {
      const s = setup();
      const ours = await s.pay();
      s.h.node.submit(ours.boc);
      s.h.node.mine(FINALITY_SKEW + 3);
      // The indexer loses our hash (so the consumer search runs) and swaps the body.
      const other = await s.request([
        nativeMessage({ to: FRESH, value: 7n, bounce: false }),
      ]);
      const swapped = Buffer.from(
        loadMessage(
          Cell.fromBoc(Buffer.from(other.boc, 'base64'))[0]!.beginParse(),
        ).body.toBoc(),
      ).toString('base64');
      s.h.node.intercept = (_endpoint, route, request) => {
        if (route === '/transactionsByMessage')
          return { json: { transactions: [], address_book: {} } };
        if (route !== '/transactions') return undefined;
        s.h.node.intercept = undefined;
        return s.h.node.fetch.fetch(request.url.href).then(async (response) => {
          const body = (await response.json()) as {
            transactions: {
              in_msg: { source: string | null; message_content: { body: string } };
            }[];
          };
          for (const tx of body.transactions) {
            if (tx.in_msg.source === null) tx.in_msg.message_content.body = swapped;
          }
          hideLookups(s.h);
          return { json: body };
        });
      };
      await expect(
        s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('makes up an external consumer claiming our seqno: its signature fails, never "replaced"', async () => {
      const s = setup();
      const ours = await s.pay();
      s.h.node.submit(ours.boc);
      s.h.node.mine();
      // A deposit after our transfer: the made-up request fits between the two (the page's
      // logical times must fall, below the wallet's last one at the attested head).
      s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
      s.h.node.mine(FINALITY_SKEW + 3);
      // A lone lying indexer loses our hash and puts, above our request in the wallet's
      // history, an external request for our seqno that another key signed.
      const madeUp = await signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: 7n, bounce: false })],
        seed: 'ab'.repeat(32),
      });
      const body = loadMessage(
        Cell.fromBoc(Buffer.from(madeUp.boc, 'base64'))[0]!.beginParse(),
      ).body;
      const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
      s.h.node.intercept = (_endpoint, route, request) => {
        if (route === '/transactionsByMessage')
          return { json: { transactions: [], address_book: {} } };
        if (route !== '/transactions') return undefined;
        s.h.node.intercept = undefined;
        return s.h.node.fetch.fetch(request.url.href).then(async (response) => {
          type Wire = {
            hash: string;
            lt: string;
            in_msg: {
              source: string | null;
              hash: string;
              hash_norm?: string;
              message_content: { hash: string; body: string };
            };
          };
          const answer = (await response.json()) as { transactions: Wire[] };
          const at = answer.transactions.findIndex((tx) => tx.in_msg.source === null);
          const real = answer.transactions[at];
          if (!real) throw new Error('no external request indexed');
          const fake = structuredClone(real);
          fake.hash = b64('ee'.repeat(32));
          fake.lt = (BigInt(real.lt) + 1n).toString();
          fake.in_msg.hash = b64('ef'.repeat(32));
          fake.in_msg.hash_norm = b64(madeUp.hashNorm);
          fake.in_msg.message_content = {
            hash: body.hash().toString('base64'),
            body: body.toBoc().toString('base64'),
          };
          answer.transactions.splice(at, 0, fake);
          hideLookups(s.h);
          return { json: answer };
        });
      };
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toMatchObject({ included: true, success: true });
    });

    it("offers another wallet's transaction under our hash: not ours, no verdict", async () => {
      const s = setup();
      const ours = await s.pay();
      // Another wallet's payment lands; the indexer returns it for our hash.
      const otherWallet = testWallet('v5r1', TESTNET);
      s.h.node.fund(otherWallet, GRAM);
      const other = await signedBoc('v5r1', TESTNET, {
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [nativeMessage({ to: FRESH, value: 5n, bounce: false })],
      });
      s.h.node.submit(other.boc);
      s.h.node.mine(3);
      s.h.node.intercept = (_endpoint, route, request) =>
        route === '/transactionsByMessage' &&
        request.url.searchParams.get('msg_hash') === ours.hashNorm
          ? s.h.node.fetch
              .fetch(request.url.href.replace(ours.hashNorm, other.hashNorm))
              .then(async (response) => ({ json: await response.json() }))
          : undefined;
      const seen = await s.h.run(
        s.h.reader.observe(ref(ours.hashNorm), ours.ordering, s.from),
      );
      expect(seen).toEqual({ seen: 'none' });
      await expect(
        s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });
  });

  // Anyone can post a W5 `internal_signed` body for about 0.01 GRAM: a relayed request
  // counts only when the wallet ran it and the wallet key signed it.
  describe('a relayed W5 request consumes the seqno only when proven', () => {
    const RELAYER = `0:${'22'.repeat(32)}`;
    /** A v5r1 test wallet, deployed by our own transfer for seqno 0. */
    async function deployed() {
      const h = tonHarness();
      const proofs = createTonProofs(h.ctx);
      const from = testWallet('v5r1', TESTNET);
      const validUntil = Math.floor(h.clock.now() / 1000) + 60;
      h.node.fund(from, 5n * GRAM);
      const ours = await signedBoc('v5r1', TESTNET, {
        seqno: 0,
        validUntil,
        deploy: true,
        messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
      });
      h.node.submit(ours.boc);
      h.node.mine();
      const relay = (seqno: number, seed?: string) =>
        h.node.inject(
          RELAYER,
          from,
          50_000_000n,
          relayedBody(TESTNET, {
            seqno,
            validUntil,
            messages: [nativeMessage({ to: FRESH, value: 2n, bounce: false })],
            ...(seed !== undefined ? { seed } : {}),
          }),
        );
      return { h, proofs, from, validUntil, ours, relay };
    }

    it('skips a forged request claiming our seqno after our transfer: never "replaced"', async () => {
      const { h, proofs, from, validUntil, ours, relay } = await deployed();
      relay(0, 'ab'.repeat(32)); // anyone can post it; the wallet ignores it
      h.node.mine(FINALITY_SKEW + 3);
      hideLookups(h);
      expect(
        await h.run(
          proofs.includedFinal(
            ref(ours.hashNorm),
            { kind: 'seqno', seqno: 0n, validUntil },
            from,
          ),
        ),
      ).toMatchObject({ included: true, success: true });
    });

    it("counts the owner's genuine relayed request, which the wallet ran", async () => {
      const { h, proofs, from, validUntil, relay } = await deployed();
      const next = await signedBoc('v5r1', TESTNET, {
        seqno: 1,
        validUntil,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: 3n, bounce: false })],
      });
      relay(1); // the owner's gasless transfer takes seqno 1 first
      h.node.mine(FINALITY_SKEW + 3);
      expect(h.node.seqno(from)).toBe(2);
      hideLookups(h);
      for (let i = 0; i < 80; i++) {
        await h.clock.advance(1_000);
        h.node.mine();
      }
      expect(
        await h.run(
          proofs.includedFinal(
            ref(next.hashNorm),
            { kind: 'seqno', seqno: 1n, validUntil },
            from,
          ),
        ),
      ).toEqual({ included: false });
    });
  });

  it('reads block hashes at a height, and none above the head', async () => {
    const s = setup();
    s.h.node.mine(3);
    expect(await s.h.run(s.proofs.blockHash(2n, 'finalized'))).toBe(
      s.h.node.block(2)?.rootHash,
    );
    expect(
      await s.h.run(s.proofs.blockHash(BigInt(s.h.node.head + 1), 'latest')),
    ).toBeNull();
  });

  describe('our own run that did not consume its seqno moved nothing', () => {
    /** Our request for seqno 0 in mode 1, for more than the wallet holds: its action phase fails. */
    const unpayable = (s: ReturnType<typeof setup>) => {
      const validUntil = s.now() + 60;
      const ours = v4Request(0, validUntil, [
        [
          SendMode.PAY_GAS_SEPARATELY,
          nativeMessage({ to: FRESH, value: 7n * GRAM, bounce: false }),
        ],
      ]);
      return { ...ours, ordering: { kind: 'seqno' as const, seqno: 0n, validUntil } };
    };

    it('decides on the seqno: undecided while the message may run again, then not included', async () => {
      const s = setup();
      const ours = unpayable(s);
      s.h.node.submit(ours.boc);
      s.h.node.mine(FINALITY_SKEW + 3);
      // Indexed under our hash, but the seqno stands and nothing left the wallet.
      expect(s.h.node.seqno(s.from)).toBe(0);
      expect(s.h.node.balance(FRESH)).toBe(0n);
      await expect(
        s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      await s.tick(80);
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toEqual({ included: false });
    });

    it('proves the later run of the same message that consumed it, found by the seqno', async () => {
      const s = setup();
      const ours = unpayable(s);
      s.h.node.submit(ours.boc);
      s.h.node.mine();
      s.h.node.fund(s.from, 5n * GRAM);
      s.h.node.submit(ours.boc); // the same message, now payable
      s.h.node.mine(FINALITY_SKEW + 3);
      expect(s.h.node.seqno(s.from)).toBe(1);
      // The indexer's lookup returns only the run that failed.
      rewrite(
        s.h,
        (_e, route) => route === '/transactionsByMessage',
        (json) => ({
          ...json,
          transactions: (json.transactions as Json[]).filter(
            (tx) =>
              (tx.description as { action: { success: boolean } }).action.success ===
              false,
          ),
        }),
      );
      const proof = await s.h.run(
        s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from),
      );
      const consumed = s.h.node.transactions().filter((tx) => tx.account === s.from)[1];
      expect(proof).toEqual({
        included: true,
        success: true,
        blockHeight: BigInt(consumed!.mcSeqno),
        blockHash: s.h.node.block(consumed!.mcSeqno)?.rootHash,
        txHash: consumed!.hash,
      });
    });
  });

  describe('the consumer search', () => {
    it('pages on the page as served, past deposits the indexer does not call final', async () => {
      const s = setup();
      const ours = await s.pay();
      s.h.node.submit(ours.boc);
      s.h.node.mine();
      // A full page of deposits lands after our transfer, which consumed our seqno.
      for (let i = 0; i < 64; i++) {
        s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
      }
      s.h.node.mine(FINALITY_SKEW + 3);
      let pages = 0;
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' && request.url.searchParams.has('account'),
        (json) =>
          pages++ === 0
            ? {
                ...json,
                transactions: (json.transactions as Json[]).map((tx) => ({
                  ...tx,
                  finality: 'confirmed',
                })),
              }
            : json,
      );
      // The hash lookup misses: only the consumer search (a positive hint) finds ours.
      const inner = s.h.node.intercept;
      s.h.node.intercept = (endpoint, route, request, signal) =>
        route === '/transactionsByMessage'
          ? { json: { transactions: [], address_book: {} } }
          : inner?.(endpoint, route, request, signal);
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toMatchObject({ included: true, success: true });
      expect(pages).toBe(2);
    });

    it('never takes a consumer the chain could not have run: its request expired first; the chain still decides', async () => {
      const s = setup();
      const ours = await s.pay();
      const theirs = await s.request([
        nativeMessage({ to: FRESH, value: 7n, bounce: false }),
      ]);
      s.h.node.submit(theirs.boc);
      s.h.node.mine(FINALITY_SKEW + 3);
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' && request.url.searchParams.has('account'),
        (json) => ({
          ...json,
          transactions: (json.transactions as Json[]).map((tx) =>
            (tx.in_msg as { source: unknown }).source === null
              ? { ...tx, now: theirs.ordering.validUntil }
              : tx,
          ),
        }),
      );
      // The hint is refused, and while ours may still run nothing is decided.
      await expect(
        s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ retryable: true });
      // The lying hint never stops the authenticated proof: once ours has expired, the
      // wallet's own chain shows the real consumer, and ours never ran.
      await s.tick(80);
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toEqual({ included: false });
    });

    it('recognises our own consumer whatever the case of the Attempt id', async () => {
      const s = setup();
      const ours = await s.pay();
      s.h.node.submit(ours.boc);
      s.h.node.mine(FINALITY_SKEW + 3);
      hideLookups(s.h);
      expect(
        await s.h.run(
          s.proofs.includedFinal(ref(ours.hashNorm.toUpperCase()), ours.ordering, s.from),
        ),
      ).toMatchObject({ included: true, success: true });
      // An id that is no message hash names no transaction: never "not included".
      await expect(
        s.h.run(s.proofs.includedFinal(ref('not-a-hash'), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('passes over the requests for later seqnos to reach ours', async () => {
      const s = setup();
      const ours = await s.pay();
      s.h.node.submit(ours.boc);
      s.h.node.mine();
      const later = await signedBoc('v4r2', TESTNET, {
        seqno: 1,
        validUntil: s.now() + 60,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: 7n, bounce: false })],
      });
      s.h.node.submit(later.boc);
      s.h.node.mine(FINALITY_SKEW + 3);
      expect(s.h.node.seqno(s.from)).toBe(2);
      hideLookups(s.h);
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toMatchObject({ included: true, success: true });
    });

    it('decides nothing past its window, and logs it by code only', async () => {
      const s = setup();
      const warnings: unknown[] = [];
      const proofs = createTonProofs({
        ...s.h.ctx,
        log: {
          ...s.h.ctx.log,
          warn: (message, fields) => warnings.push({ message, fields }),
        },
      });
      const ours = await s.pay();
      const theirs = await s.request([
        nativeMessage({ to: FRESH, value: 7n, bounce: false }),
      ]);
      s.h.node.submit(theirs.boc);
      s.h.node.mine();
      // Eight full pages of deposits since the request that consumed our seqno.
      for (let i = 0; i < CONSUMER_PAGES * 64; i++) {
        s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
      }
      s.h.node.mine(FINALITY_SKEW + 3);
      let pages = 0;
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' && request.url.searchParams.has('account'),
        (json) => {
          pages += 1;
          return json;
        },
      );
      await expect(
        s.h.run(proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      expect(pages).toBe(CONSUMER_PAGES);
      expect(warnings).toEqual([
        {
          message: 'the seqno consumer is beyond the search window',
          fields: { code: 'SEQNO_CONSUMER_NOT_FOUND' },
        },
      ]);
      // Expired: the liteserver's own chain decides, within its cap, else nothing.
      s.h.node.intercept = undefined;
      await s.tick(80);
      warnings.length = 0;
      let walked = 0;
      rewrite(
        s.h,
        (_e, route) => route === '/getTransactions',
        (json) => {
          walked += 1;
          return json;
        },
      );
      await expect(
        s.h.run(proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      expect(walked).toBe(WALK_PAGES);
      expect(warnings).toContainEqual({
        message: 'the wallet history is beyond the proof window',
        fields: { code: 'TX_CHAIN_WALK_EXHAUSTED' },
      });
      // Over 500 transactions, walked twice: a Jest guard, no driver timer.
    }, 20_000);
  });

  describe('lookups bound to the block asked', () => {
    it('never takes the header of another block for the attested head or a block hash', async () => {
      const s = setup();
      s.h.node.mine(FINALITY_SKEW + 5);
      // The endpoint answers the next block's header, whatever block is asked.
      rewrite(
        s.h,
        (_e, route) => route === '/getBlockHeader',
        (json) => json,
        (url) =>
          url.searchParams.set(
            'seqno',
            String(Number(url.searchParams.get('seqno')) + 1),
          ),
      );
      await expect(s.h.run(s.proofs.finalizedHead())).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
      await expect(s.h.run(s.proofs.blockHash(2n, 'finalized'))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
      expect(await s.h.run(s.proofs.blockHash(-1n, 'finalized'))).toBeNull();
    });

    it.each([
      ['a header of a basechain block', { id: { workchain: 0 } }],
      ['a header of another shard', { id: { shard: '4611686018427387904' } }],
      ['a header of another network', { global_id: -239 }],
    ])('never takes %s for the attested head', async (_what, edit) => {
      const s = setup();
      s.h.node.mine(FINALITY_SKEW + 5);
      rewrite(
        s.h,
        (_e, route) => route === '/getBlockHeader',
        (json) => {
          const result = json.result as Json;
          return {
            ...json,
            result: {
              ...result,
              ...edit,
              id: { ...(result.id as Json), ...('id' in edit ? edit.id : {}) },
            },
          };
        },
      );
      await expect(s.h.run(s.proofs.finalizedHead())).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    });

    it.each([
      ['leaves a shard out', (shards: Json[]) => shards.slice(0, 1)],
      ['is empty', () => []],
      [
        'leaves a gap',
        (shards: Json[]) => [
          shards[0]!,
          { ...shards[1]!, shard: '-2305843009213693952' },
        ],
      ],
      [
        'holds a shard id of zero',
        (shards: Json[]) => [{ ...shards[0]!, shard: '0' }, ...shards],
      ],
    ])('never proves expiry from a shard set that %s', async (_what, edit) => {
      const s = setup({
        node: { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 40 },
      });
      const { ordering } = await s.pay();
      await s.tick(90);
      // The first shard is past valid_until; the second is not.
      rewrite(
        s.h,
        (_e, route) => route === '/getShards',
        (json) => {
          const result = json.result as { shards: Json[] };
          return { ...json, result: { ...result, shards: edit(result.shards) } };
        },
      );
      await expect(s.h.run(s.proofs.expired(ordering))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    });

    it.each([
      ['another workchain', { workchain: 1 }],
      ['another shard', { shard: '4611686018427387904' }],
      ['another seqno', { seqno: 2000 }],
      ['another root hash', { root_hash: 'A'.repeat(43) + '=' }],
      ['another file hash', { file_hash: 'A'.repeat(43) + '=' }],
      ['another network', { global_id: -239 }],
    ])('never proves expiry from a shard header naming %s', async (_what, edit) => {
      const s = setup({
        node: { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 40 },
      });
      const { ordering } = await s.pay();
      await s.tick(90);
      // The lagging second shard's header, past valid_until, but not the block asked.
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/getBlockHeader' &&
          request.url.searchParams.get('shard') === '-4611686018427387904',
        (json) => {
          const result = json.result as Json;
          const { global_id, ...id } = edit as Json;
          return {
            ...json,
            result: {
              ...result,
              gen_utime: ordering.validUntil + 100,
              ...(global_id !== undefined ? { global_id } : {}),
              id: { ...(result.id as Json), ...id },
            },
          };
        },
      );
      await expect(s.h.run(s.proofs.expired(ordering))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    });

    it("never proves expiry from another shard block's time", async () => {
      const s = setup({
        node: { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 40 },
      });
      const { ordering } = await s.pay();
      await s.tick(90);
      // The second shard's header is answered with the first shard's block.
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/getBlockHeader' &&
          request.url.searchParams.get('shard') === '-4611686018427387904',
        (json) => json,
        (url) => {
          url.searchParams.set('shard', '4611686018427387904');
          url.searchParams.set(
            'seqno',
            String(Number(url.searchParams.get('seqno')) - 1000),
          );
        },
      );
      await expect(s.h.run(s.proofs.expired(ordering))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    });
  });

  // The seqno at the attested head counts only from an active wallet, or from an
  // uninitialized one for slot 0: a frozen or deleted wallet decides nothing, never
  // "seqno 0".
  describe('the wallet state at the attested head', () => {
    it('proves expiry exactly when valid_until reaches the block time, not a second earlier', async () => {
      const s = setup();
      const { hashNorm, ordering } = await s.pay();
      // Block k + 1 is sealed k seconds on: the attested head (head − 10) then trails by 10 s.
      await s.tick(69);
      expect(s.h.node.block(s.h.node.head - FINALITY_SKEW)!.genUtime).toBe(
        ordering.validUntil - 1,
      );
      expect(await s.h.run(s.proofs.expired(ordering))).toBe(false);
      await expect(
        s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await s.tick(1);
      expect(await s.h.run(s.proofs.expired(ordering))).toBe(true);
      expect(
        await s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
      ).toEqual({ included: false });
    });

    it('never takes the state at another block for the state at the attested head', async () => {
      const s = setup();
      const { hashNorm, ordering } = await s.pay();
      await s.tick(80);
      rewrite(
        s.h,
        (_e, route) => route === '/getAddressInformation',
        (json) => {
          const result = json.result as { block_id: Json };
          const block = result.block_id;
          return {
            ...json,
            result: { ...result, block_id: { ...block, seqno: Number(block.seqno) + 1 } },
          };
        },
      );
      await expect(
        s.h.run(s.proofs.includedFinal(ref(hashNorm), ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    });

    it('never reads an uninitialized wallet as seqno 0 past our first slot', async () => {
      const s = setup();
      const next = await signedBoc('v4r2', TESTNET, {
        seqno: 1,
        validUntil: s.now() + 60,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: 7n, bounce: false })],
      });
      const ordering = { kind: 'seqno' as const, seqno: 1n, validUntil: s.now() + 60 };
      await s.tick(80);
      await expect(
        s.h.run(s.proofs.includedFinal(ref(next.hashNorm), ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('reads no seqno outside a u32, which decides nothing', async () => {
      const s = setup();
      const theirs = await s.request([
        nativeMessage({ to: FRESH, value: 7n, bounce: false }),
      ]);
      s.h.node.submit(theirs.boc);
      s.h.node.mine();
      const validUntil = s.now() + 60;
      const next = await signedBoc('v4r2', TESTNET, {
        seqno: 1,
        validUntil,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: 7n, bounce: false })],
      });
      const ordering = { kind: 'seqno' as const, seqno: 1n, validUntil };
      await s.tick(80);
      const seqnoAnswer = (value: string) =>
        rewrite(
          s.h,
          (_e, route, request) =>
            route === '/runGetMethod' &&
            request.json<{ method: string }>().method === 'seqno',
          (json) => ({
            ...json,
            result: { ...(json.result as Json), stack: [['num', value]] },
          }),
        );
      // Never the seqno 1 of an expired message: "not included" would follow.
      seqnoAnswer('-0x1');
      await expect(
        s.h.run(s.proofs.includedFinal(ref(next.hashNorm), ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      seqnoAnswer('0x100000000');
      expect(await s.h.run(s.proofs.slotConsumed(ordering, s.from, 'finalized'))).toBe(
        false,
      );
    });
  });
});

// A false "not included" lets `rebuild` pay twice: a wallet deleted and re-deployed, a
// lying indexer replaying our own expired request, or a seqno read bound to no block
// could each produce one. So it rests only on the wallet's raw liteserver transactions,
// each hashed locally and linked back to an attested account state; the indexer is a
// positive hint only.
describe('"not included" rests on the chain\'s own transactions', () => {
  /** A v4r2 request of the test key's wallet sending everything and deleting it (+128+32). */
  const destroy = (s: ReturnType<typeof setup>, seqno: number) =>
    v4Request(seqno, s.now() + 60, [
      [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
    ]);
  /** A transfer of the test key's wallet (a deploy at seqno 0): its request and ordering. */
  const transfer = async (s: ReturnType<typeof setup>, seqno: number, value = GRAM) => {
    const validUntil = s.now() + 60;
    const signed = await signedBoc('v4r2', TESTNET, {
      seqno,
      validUntil,
      deploy: seqno === 0,
      messages: [nativeMessage({ to: FRESH, value, bounce: false })],
    });
    return {
      ...signed,
      ordering: {
        kind: 'seqno' as const,
        seqno: BigInt(seqno),
        validUntil,
        validFrom: s.now(),
      },
    };
  };
  const refund = (s: ReturnType<typeof setup>) => {
    s.h.node.inject(PAYER, s.from, 2n * GRAM, beginCell().endCell());
    s.h.node.mine();
  };
  const final = (
    s: ReturnType<typeof setup>,
    t: { readonly hashNorm: string; readonly ordering: OrderingData },
  ) => s.h.run(s.proofs.includedFinal(ref(t.hashNorm), t.ordering, s.from));
  /**
   * The indexer holds one row below the chain's first transaction (an earlier incarnation):
   * by default a deposit that bounced before the wallet existed, its code never run.
   */
  const earlierHistory = (s: ReturnType<typeof setup>, patch: Json) =>
    rewrite(
      s.h,
      (_e, route, request) =>
        route === '/transactions' && request.url.searchParams.has('end_lt'),
      (json, request) => ({
        ...json,
        transactions: [
          {
            account: s.from.toUpperCase(),
            hash: Buffer.alloc(32, 9).toString('base64'),
            lt: request.url.searchParams.get('end_lt'),
            now: 1,
            mc_block_seqno: 1,
            trace_id: Buffer.alloc(32, 9).toString('base64'),
            orig_status: 'nonexist',
            end_status: 'uninit',
            total_fees: '0',
            description: {
              type: 'ord',
              aborted: true,
              compute_ph: { skipped: true, reason: 'no_state' },
            },
            in_msg: null,
            out_msgs: [],
            ...patch,
          },
        ],
      }),
    );

  it("never takes our own earlier, expired request for the seqno for our landed transfer's consumer", async () => {
    const s = setup();
    // Attempt A for seqno 0 never lands and expires; its rebuild B, for seqno 0 again, lands.
    const a = await s.pay();
    await s.tick(80);
    const b = await s.pay();
    s.h.node.submit(b.boc);
    s.h.node.mine(13);
    expect(s.h.node.balance(FRESH)).toBe(GRAM);
    const aMessage = loadMessage(
      Cell.fromBoc(Buffer.from(a.boc, 'base64'))[0]!.beginParse(),
    );
    const aCell = Cell.fromBoc(Buffer.from(a.boc, 'base64'))[0]!;
    // A lone lying indexer loses B and shows A's genuine body, run before A expired, in its place.
    const lie = (json: Json) => ({
      ...json,
      transactions: (json.transactions as Json[]).map((tx) => {
        const inMsg = tx.in_msg as Json;
        if (inMsg.source !== null) return tx;
        return {
          ...tx,
          now: a.ordering.validUntil - 5,
          in_msg: {
            ...inMsg,
            hash: aCell.hash().toString('base64'),
            hash_norm: Buffer.from(a.hashNorm, 'hex').toString('base64'),
            message_content: {
              ...(inMsg.message_content as Json),
              hash: aMessage.body.hash().toString('base64'),
              body: aMessage.body.toBoc().toString('base64'),
            },
          },
        };
      }),
    });
    const lying = (everywhere: boolean) => {
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' &&
          (everywhere || request.url.searchParams.has('account')),
        lie,
      );
      const inner = s.h.node.intercept;
      s.h.node.intercept = (endpoint, route, request, signal) =>
        route === '/transactionsByMessage'
          ? { json: { transactions: [], address_book: {} } }
          : inner?.(endpoint, route, request, signal);
    };
    lying(true);
    // B may still run as far as the proof knows: nothing is decided.
    await expect(final(s, b)).rejects.toMatchObject({ retryable: true });
    await s.tick(80);
    // Expired: the liteserver's chain holds B itself; the lying record is never proof.
    await expect(final(s, b)).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    lying(false);
    expect(await final(s, b)).toMatchObject({ included: true, success: true });
  });

  it('never proves "not included" once the wallet was deleted and re-deployed after our transfer', async () => {
    const s = setup();
    const theirs = await transfer(s, 0, 7n);
    s.h.node.submit(theirs.boc);
    s.h.node.mine();
    const ours = await transfer(s, 1);
    s.h.node.submit(ours.boc);
    s.h.node.mine();
    // Software sharing the key sends everything and deletes the wallet; anyone re-funds and
    // re-deploys it from its StateInit: its seqno is back at 1, our slot.
    s.h.node.submit(destroy(s, 2).boc);
    s.h.node.mine();
    expect(s.h.node.status(s.from)).toBe('uninitialized');
    refund(s);
    s.h.node.submit((await transfer(s, 0, 5n)).boc);
    s.h.node.mine(2);
    expect(s.h.node.seqno(s.from)).toBe(1);
    expect(s.h.node.balance(FRESH)).toBe(GRAM + 12n);
    await s.tick(80);
    // The indexer's lookup by hash still finds ours: proven.
    expect(await final(s, ours)).toMatchObject({
      included: true,
      success: true,
    });
    // Once it misses, the chain the liteserver holds starts after the deletion: nothing.
    hideLookups(s.h);
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // The new incarnation consumes seqno 1 again, with another message: still nothing.
    s.h.node.intercept = undefined;
    s.h.node.submit((await transfer(s, 1, 3n)).boc);
    s.h.node.mine(FINALITY_SKEW + 3);
    expect(s.h.node.seqno(s.from)).toBe(2);
    hideLookups(s.h);
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('never proves "not included" for our slot 0 on a wallet deleted after our transfer', async () => {
    const s = setup();
    const ours = await transfer(s, 0);
    s.h.node.submit(ours.boc);
    s.h.node.mine();
    s.h.node.submit(destroy(s, 1).boc);
    s.h.node.mine();
    await s.tick(80);
    hideLookups(s.h);
    // Left non-existent: its history shows the wallet ran.
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // Re-funded, still uninitialized: its chain starts after the deletion.
    s.h.node.intercept = undefined;
    refund(s);
    hideLookups(s.h);
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('finds our transfer behind a destroy that kept the account in the same chain', async () => {
    const s = setup();
    const theirs = await transfer(s, 0, 7n);
    s.h.node.submit(theirs.boc);
    s.h.node.mine();
    const ours = await transfer(s, 1);
    s.h.node.submit(ours.boc);
    s.h.node.mine();
    // An extra currency keeps the destroyed account, uninitialized (transaction.cpp).
    s.h.node.holdExtraCurrency(s.from);
    s.h.node.submit(destroy(s, 2).boc);
    s.h.node.mine();
    refund(s);
    s.h.node.submit((await transfer(s, 0, 5n)).boc);
    s.h.node.mine();
    expect(s.h.node.seqno(s.from)).toBe(1);
    await s.tick(80);
    hideLookups(s.h);
    expect(await final(s, ours)).toMatchObject({
      included: true,
      success: true,
    });
  });

  it('decides the honest cases: a first send that expired, and a replacement, after a real deposit', async () => {
    const s = setup();
    s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
    s.h.node.mine();
    const ours = await transfer(s, 0);
    await s.tick(80);
    expect(await final(s, ours)).toEqual({ included: false });
    const replaced = setup();
    replaced.h.node.inject(PAYER, replaced.from, GRAM, beginCell().endCell());
    replaced.h.node.mine();
    const mine = await transfer(replaced, 0);
    replaced.h.node.submit((await transfer(replaced, 0, 7n)).boc);
    replaced.h.node.mine();
    await replaced.tick(80);
    expect(await final(replaced, mine)).toEqual({ included: false });
  });

  it('ends the walk at the window: a history older than our message is not read', async () => {
    const s = setup();
    s.h.node.submit((await transfer(s, 0, 7n)).boc);
    s.h.node.mine();
    for (let i = 0; i < 40; i++) {
      s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
    }
    s.h.node.mine();
    // Older than the recorded start, less the chain-time tolerance.
    await s.tick(CHAIN_TIME_TOLERANCE + 100);
    const ours = await transfer(s, 1);
    await s.tick(80);
    let walked = 0;
    rewrite(
      s.h,
      (_e, route) => route === '/getTransactions',
      (json) => {
        walked += 1;
        return json;
      },
    );
    expect(await final(s, ours)).toEqual({ included: false });
    expect(walked).toBe(1);
  });

  it('finds the consumer of our seqno past the window when the window is too short', async () => {
    const s = setup();
    // Built when the lifetime was an hour (validForSeconds lowered since): ours lands early.
    const validUntil = s.now() + 3_600;
    const ours = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    });
    s.h.node.submit(ours.boc);
    s.h.node.mine();
    s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
    s.h.node.mine();
    for (let i = 0; i < 70; i++) {
      await s.h.clock.advance(60_000);
      s.h.node.mine();
    }
    // The indexer has lost it altogether: only the liteserver's chain shows it.
    s.h.node.intercept = (_endpoint, route) =>
      route === '/transactionsByMessage' || route === '/transactions'
        ? { json: { transactions: [], address_book: {} } }
        : undefined;
    await expect(
      s.h.run(
        s.proofs.includedFinal(
          ref(ours.hashNorm),
          { kind: 'seqno', seqno: 0n, validUntil },
          s.from,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    // With its record back (the proof reads it by the hash the chain gives), proven.
    s.h.node.intercept = (_endpoint, route, request) =>
      route === '/transactionsByMessage' ||
      (route === '/transactions' && request.url.searchParams.has('account'))
        ? { json: { transactions: [], address_book: {} } }
        : undefined;
    expect(
      await s.h.run(
        s.proofs.includedFinal(
          ref(ours.hashNorm),
          { kind: 'seqno', seqno: 0n, validUntil },
          s.from,
        ),
      ),
    ).toMatchObject({ included: true, success: true });
  });

  it("never takes a liteserver's answer that is not the chain's (a foreign cell, a dropped transaction)", async () => {
    const s = setup();
    s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
    s.h.node.mine();
    const ours = await transfer(s, 0);
    s.h.node.submit((await transfer(s, 0, 7n)).boc);
    s.h.node.mine();
    s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
    s.h.node.mine();
    await s.tick(80);
    for (const edit of [
      // Each row carries the next row's cell.
      (rows: Json[]) =>
        rows.map((row, i) => ({ ...row, data: rows[(i + 1) % rows.length]!.data })),
      // The newest transaction is dropped.
      (rows: Json[]) => rows.slice(1),
      // The same transaction rewritten (a fee changed): its id, lt and account, not its hash.
      (rows: Json[]) =>
        rows.map((row) => {
          const cell = Cell.fromBoc(Buffer.from(String(row.data), 'base64'))[0]!;
          const tx = loadTransaction(cell.beginParse());
          const forged = beginCell()
            .store(
              storeTransaction({
                ...tx,
                totalFees: { coins: tx.totalFees.coins + 1n },
              }),
            )
            .endCell();
          return { ...row, data: forged.toBoc().toString('base64') };
        }),
      // Another account's transaction under the right id.
      (rows: Json[]) =>
        rows.map((row) => ({
          ...row,
          data: s.h.node
            .transactions()
            .find((tx) => tx.account === FRESH)!
            .raw.toBoc()
            .toString('base64'),
        })),
    ]) {
      rewrite(
        s.h,
        (_e, route) => route === '/getTransactions',
        (json) => ({ ...json, result: edit(json.result as Json[]) }),
      );
      await expect(final(s, ours)).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    s.h.node.intercept = undefined;
    expect(await final(s, ours)).toEqual({ included: false });
  });

  it('binds the seqno and the state to the attested block and the account state', async () => {
    const s = setup();
    const ours = await s.pay();
    s.h.node.submit((await transfer(s, 0, 7n)).boc);
    s.h.node.mine();
    await s.tick(80);
    const edits: [string, (result: Json) => Json][] = [
      [
        '/runGetMethod',
        (r) => ({
          ...r,
          block_id: {
            ...(r.block_id as Json),
            seqno: Number((r.block_id as Json).seqno) - 1,
          },
        }),
      ],
      [
        '/runGetMethod',
        (r) => ({ ...r, block_id: { ...(r.block_id as Json), root_hash: ZERO_HASH } }),
      ],
      [
        '/runGetMethod',
        (r) => ({
          ...r,
          last_transaction_id: { ...(r.last_transaction_id as Json), hash: ZERO_HASH },
        }),
      ],
      [
        '/getAddressInformation',
        (r) => ({ ...r, block_id: { ...(r.block_id as Json), root_hash: ZERO_HASH } }),
      ],
      [
        '/getAddressInformation',
        (r) => ({ ...r, block_id: { ...(r.block_id as Json), workchain: 0 } }),
      ],
    ];
    for (const [route, edit] of edits) {
      rewrite(
        s.h,
        (_e, served, request) =>
          served === route &&
          (route !== '/runGetMethod' ||
            request.json<{ method: string }>().method === 'seqno'),
        (json) => ({ ...json, result: edit(json.result as Json) }),
      );
      await expect(final(s, ours)).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    s.h.node.intercept = undefined;
    expect(await final(s, ours)).toEqual({ included: false });
  });

  it('walks to the chain start behind an activation inside the window, however short the window (a lowered lifetime)', async () => {
    const s = setup();
    // Built with an hour's lifetime (validForSeconds lowered since): ours lands at once.
    const validUntil = s.now() + 3_600;
    const ours = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    });
    s.h.node.submit(ours.boc);
    s.h.node.mine();
    s.h.node.submit(destroy(s, 1).boc);
    s.h.node.mine();
    refund(s); // the new chain starts before the (too short) window
    for (let i = 0; i < 59; i++) {
      await s.h.clock.advance(60_000);
      s.h.node.mine();
    }
    s.h.node.submit((await transfer(s, 0, 5n)).boc); // the re-deploy, inside the window
    s.h.node.mine();
    await s.tick(80);
    hideLookups(s.h);
    await expect(
      final(s, {
        hashNorm: ours.hashNorm,
        ordering: { kind: 'seqno', seqno: 0n, validUntil },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('decides nothing after a reset inside the window, even when ours never ran', async () => {
    const s = setup();
    s.h.node.submit((await transfer(s, 0, 7n)).boc);
    s.h.node.mine();
    s.h.node.holdExtraCurrency(s.from);
    s.h.node.submit(destroy(s, 1).boc);
    s.h.node.mine();
    refund(s);
    s.h.node.submit((await transfer(s, 0, 5n)).boc);
    s.h.node.mine();
    const ours = await transfer(s, 1); // never sent
    await s.tick(80);
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('decides nothing while the indexer has not reached the attested block', async () => {
    const s = setup();
    const ours = await s.pay();
    await s.tick(80);
    s.h.node.indexerLag = 200;
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    s.h.node.indexerLag = 0;
    expect(await final(s, ours)).toEqual({ included: false });
  });

  it('never takes a forged relayed request the chain ran for the consumer of our seqno', async () => {
    const h = tonHarness();
    const proofs = createTonProofs(h.ctx);
    const from = testWallet('v5r1', TESTNET);
    h.node.fund(from, 5n * GRAM);
    const validUntil = Math.floor(h.clock.now() / 1000) + 3_600;
    const ours = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    });
    h.node.submit(ours.boc);
    h.node.mine();
    const deposit = () => {
      h.node.inject(PAYER, from, 1_000_000n, beginCell().endCell());
      h.node.mine();
    };
    deposit();
    // Anyone can post a relayed body claiming our seqno: the wallet runs it and ignores it.
    h.node.inject(
      `0:${'22'.repeat(32)}`,
      from,
      50_000_000n,
      relayedBody(TESTNET, {
        seqno: 0,
        validUntil,
        messages: [nativeMessage({ to: FRESH, value: 2n, bounce: false })],
        seed: 'ab'.repeat(32),
      }),
    );
    h.node.mine();
    deposit();
    for (let i = 0; i < 70; i++) {
      await h.clock.advance(60_000);
      h.node.mine();
    }
    for (let i = 0; i < 20; i++) {
      await h.clock.advance(1_000);
      h.node.mine();
    }
    h.node.intercept = (_endpoint, route, request) =>
      route === '/transactionsByMessage' ||
      (route === '/transactions' && request.url.searchParams.has('account'))
        ? { json: { transactions: [], address_book: {} } }
        : undefined;
    expect(
      await h.run(
        proofs.includedFinal(
          ref(ours.hashNorm),
          { kind: 'seqno', seqno: 0n, validUntil },
          from,
        ),
      ),
    ).toMatchObject({ included: true, success: true });
  });

  it('reads an earlier history with the never-ran rule: any run, or no statuses, decides nothing', async () => {
    const s = setup();
    const ours = await s.pay(); // never sent; the wallet has no transaction at all
    await s.tick(80);
    const row = (lt: bigint, patch: Json): Json => ({
      account: s.from.toUpperCase(),
      hash: Buffer.alloc(32, Number(lt % 255n) + 1).toString('base64'),
      lt: lt.toString(),
      now: 1,
      mc_block_seqno: 1,
      trace_id: Buffer.alloc(32, 7).toString('base64'),
      orig_status: 'nonexist',
      end_status: 'uninit',
      total_fees: '0',
      description: {
        type: 'ord',
        aborted: true,
        compute_ph: { skipped: true, reason: 'no_state' },
      },
      in_msg: null,
      out_msgs: [],
      ...patch,
    });
    const history = (rows: (endLt: bigint) => Json[]) =>
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' && request.url.searchParams.has('account'),
        (json, request) => {
          const endLt = request.url.searchParams.get('end_lt');
          return {
            ...json,
            transactions: rows(endLt === null ? 1_000_000n : BigInt(endLt)),
          };
        },
      );
    // An earlier deposit that never ran the code: harmless.
    history(() => [row(500n, {})]);
    expect(await final(s, ours)).toEqual({ included: false });
    // The code ran, or the indexer does not say what the account was: nothing.
    for (const patch of [
      {
        description: {
          type: 'ord',
          aborted: false,
          compute_ph: { skipped: false, success: true, exit_code: 0 },
          action: {
            success: true,
            valid: true,
            no_funds: false,
            result_code: 0,
            tot_actions: 0,
            skipped_actions: 0,
            msgs_created: 0,
          },
        },
      },
      { orig_status: undefined },
      { end_status: undefined },
      { end_status: 'active' },
      { orig_status: 'frozen', end_status: 'frozen' },
    ]) {
      history(() => [row(500n, patch)]);
      await expect(final(s, ours)).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
    // A history past the window decides nothing either.
    history((endLt) => Array.from({ length: 64 }, (_, i) => row(endLt - BigInt(i), {})));
    await expect(final(s, ours)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it("reads an active wallet's chain start by the code-never-ran rule", async () => {
    const s = setup();
    s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
    s.h.node.mine();
    const ours = await transfer(s, 0);
    s.h.node.submit((await transfer(s, 0, 7n)).boc);
    s.h.node.mine();
    await s.tick(80);
    expect(await final(s, ours)).toEqual({ included: false });
    // Below the chain's first transaction, an earlier incarnation whose code never ran (a
    // deposit that bounced before the wallet existed) cannot hold our message: it decides.
    earlierHistory(s, {});
    expect(await final(s, ours)).toEqual({ included: false });
    // One whose code ran, or whose statuses the indexer leaves out, decides nothing.
    for (const patch of CODE_RAN) {
      earlierHistory(s, patch);
      await expect(final(s, ours)).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  // The walk starts at the Attempt's recorded `validFrom`, less the clock tolerance,
  // never at a window from the current config: a window that starts too late misses an
  // earlier run of ours, and a reset then proves "not included" falsely.
  describe("the window starts at the attempt's own chain time", () => {
    /**
     * Theirs takes seqno 0; ours (seqno 1, `ordering`) lands and pays at once; software
     * sharing the key deletes the wallet, which is re-funded and re-deployed at seqno 1 again.
     */
    async function resetAfterOurs(s: ReturnType<typeof setup>, validUntil: number) {
      s.h.node.submit((await transfer(s, 0, 7n)).boc);
      s.h.node.mine();
      const ours = await signedBoc('v4r2', TESTNET, {
        seqno: 1,
        validUntil,
        deploy: false,
        messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
      });
      s.h.node.submit(ours.boc);
      s.h.node.mine(2);
      expect(s.h.node.balance(FRESH)).toBe(GRAM + 7n);
      s.h.node.submit(destroy(s, 2).boc);
      s.h.node.mine();
      refund(s);
      s.h.node.submit((await transfer(s, 0, 5n)).boc);
      s.h.node.mine();
      expect(s.h.node.seqno(s.from)).toBe(1);
      await s.tick(validUntil - s.now() + 40);
      hideLookups(s.h);
      return ours;
    }

    it('never misses a reset because validForSeconds was lowered since the build', async () => {
      const s = setup();
      const builtAt = s.now();
      // Built with a lifetime of 360 s; the network's validForSeconds is 60 now.
      const validUntil = builtAt + 360;
      const ours = await resetAfterOurs(s, validUntil);
      for (const ordering of [
        { kind: 'seqno' as const, seqno: 1n, validUntil, validFrom: builtAt },
        // An ordering without the recorded start (before this field): the widest window.
        { kind: 'seqno' as const, seqno: 1n, validUntil },
      ]) {
        await expect(
          final(s, { hashNorm: ours.hashNorm, ordering }),
        ).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      }
    });

    it('never misses a reset because the build endpoint ran ahead of the clock', async () => {
      const s = setup();
      const builtAt = s.now();
      // The endpoint's chain time was 290 s ahead (within CHAIN_TIME_TOLERANCE): the
      // lifetime runs from it, but the message ran at once.
      const validUntil = builtAt + 290 + 60;
      const ours = await resetAfterOurs(s, validUntil);
      await expect(
        final(s, {
          hashNorm: ours.hashNorm,
          ordering: { kind: 'seqno', seqno: 1n, validUntil, validFrom: builtAt },
        } as { hashNorm: string; ordering: TonSeqnoOrdering }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('never misses a reset because the local clock ran ahead of the chain at the build', async () => {
      const s = setup();
      const builtAt = s.now();
      // Both the clock and the endpoint 200 s ahead of the chain (within the tolerance): the
      // recorded start is 200 s after the message could run.
      const validUntil = builtAt + 200 + 60;
      const ours = await resetAfterOurs(s, validUntil);
      await expect(
        final(s, {
          hashNorm: ours.hashNorm,
          ordering: { kind: 'seqno', seqno: 1n, validUntil, validFrom: builtAt + 200 },
        } as { hashNorm: string; ordering: TonSeqnoOrdering }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('includes the window start itself: a message may run exactly the tolerance before the recorded start', async () => {
      const s = setup();
      const builtAt = s.now();
      // The clock a whole tolerance ahead of the chain: ours, and the reset, run in the very
      // second the window starts.
      const validUntil = builtAt + CHAIN_TIME_TOLERANCE + 60;
      const ours = await resetAfterOurs(s, validUntil);
      await expect(
        final(s, {
          hashNorm: ours.hashNorm,
          ordering: {
            kind: 'seqno',
            seqno: 1n,
            validUntil,
            validFrom: builtAt + CHAIN_TIME_TOLERANCE,
          },
        } as { hashNorm: string; ordering: TonSeqnoOrdering }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('takes the widest window when the recorded start is missing or malformed', async () => {
      const s = setup();
      const builtAt = s.now();
      const validUntil = builtAt + 360;
      const ours = await resetAfterOurs(s, validUntil);
      for (const validFrom of [
        'x',
        Number.NaN,
        1.5,
        -1,
        validUntil + 1,
        validUntil - 5,
        validUntil - 86_701,
        10n,
      ]) {
        await expect(
          final(s, {
            hashNorm: ours.hashNorm,
            ordering: { kind: 'seqno', seqno: 1n, validUntil, validFrom } as never,
          }),
        ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      }
    });

    it('still decides an honest replacement whatever the recorded start says', async () => {
      const s = setup();
      s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
      s.h.node.mine();
      const ours = await transfer(s, 0);
      s.h.node.submit((await transfer(s, 0, 7n)).boc);
      s.h.node.mine();
      await s.tick(80);
      expect(await final(s, ours)).toEqual({ included: false });
      const { validFrom: _dropped, ...legacy } = ours.ordering as TonSeqnoOrdering;
      expect(await final(s, { hashNorm: ours.hashNorm, ordering: legacy })).toEqual({
        included: false,
      });
    });

    it("stops an uninitialized wallet's walk at the window", async () => {
      const s = setup();
      for (let i = 0; i < 40; i++) {
        s.h.node.inject(PAYER, s.from, 1_000_000n, beginCell().endCell());
      }
      s.h.node.mine();
      await s.tick(CHAIN_TIME_TOLERANCE + 100);
      const ours = await transfer(s, 0); // the first send: never lands
      await s.tick(80);
      let walked = 0;
      rewrite(
        s.h,
        (_e, route) => route === '/getTransactions',
        (json) => {
          walked += 1;
          return json;
        },
      );
      expect(await final(s, ours)).toEqual({ included: false });
      expect(walked).toBe(1);
    });

    it('reads a chain start inside the window by the code-never-ran rule, for an uninitialized wallet too', async () => {
      const s = setup();
      s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
      s.h.node.mine();
      const ours = await transfer(s, 0);
      await s.tick(80);
      expect(await final(s, ours)).toEqual({ included: false });
      earlierHistory(s, {});
      expect(await final(s, ours)).toEqual({ included: false });
      for (const patch of CODE_RAN) {
        earlierHistory(s, patch);
        await expect(final(s, ours)).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      }
    });
  });

  // A rule that refused every earlier history left an uninitialized wallet with one
  // earlier bounce undecided forever.
  it('decides a slot-0 proof near the first funding after an earlier bounced delivery', async () => {
    const h = tonHarness();
    const proofs = createTonProofs(h.ctx);
    const from = testWallet('v4r2', TESTNET);
    const now = () => Math.floor(h.clock.now() / 1000);
    // Someone sends a bounceable transfer to the not-yet-existing wallet: it bounces.
    h.node.inject(PAYER, from, GRAM, beginCell().endCell(), true);
    h.node.mine(2);
    await h.clock.advance(3_600_000);
    h.node.mine();
    // The wallet is funded (its chain starts), and our first send is built at once; it
    // never lands.
    h.node.inject(PAYER, from, 5n * GRAM, beginCell().endCell());
    h.node.mine();
    const validUntil = now() + 60;
    const ours = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    });
    for (let i = 0; i < 400; i++) {
      await h.clock.advance(1_000);
      h.node.mine();
    }
    const ordering = {
      kind: 'seqno' as const,
      seqno: 0n,
      validUntil,
      validFrom: validUntil - 60,
    };
    // The earlier incarnation's code never ran, so it cannot hold our message (was: "the
    // wallet may have been reset since our message", undecided forever).
    expect(await h.run(proofs.includedFinal(ref(ours.hashNorm), ordering, from))).toEqual(
      {
        included: false,
      },
    );
  });

  it('decides nothing for a lifetime that is no time', async () => {
    const s = setup();
    const ours = await s.pay();
    await s.tick(80);
    const unset = { kind: 'seqno' as const, seqno: 0n, validUntil: 0 };
    await expect(s.h.run(s.proofs.expired(unset))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(
      s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), unset, s.from)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(await final(s, ours)).toEqual({ included: false });
  });
});

// Resending the same signed bytes is not idempotent on TON: after our transfer lands,
// software sharing the key can delete the wallet, a deposit re-funds it, and a resend
// runs the message again. So the broadcaster runs the authenticated walk before every
// send of stored bytes: when it finds ours, the bytes count as already known; after a
// reset, or when it cannot decide, nothing is sent.
describe('the replay guard', () => {
  /** Our first send, never sent: what the broadcaster hands the guard. */
  const stored = async (s: ReturnType<typeof setup>) => {
    const { hashNorm, ordering } = await s.pay();
    return {
      wallet: s.from,
      id: hashNorm,
      seqno: 0n,
      validUntil: ordering.validUntil,
      validFrom: ordering.validFrom,
    };
  };
  /** The latest state (a read without `seqno`), as `edit` makes it. */
  const freshState = (s: ReturnType<typeof setup>, edit: (result: Json) => Json) =>
    rewrite(
      s.h,
      (_e, route, request) =>
        route === '/getAddressInformation' && !request.url.searchParams.has('seqno'),
      (json) => ({ ...json, result: edit(json.result as Json) }),
    );
  const deposits = async (s: ReturnType<typeof setup>, count: number) => {
    for (let i = 0; i < count; i++) {
      s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
      s.h.node.mine();
    }
    await s.tick(FINALITY_SKEW + 2);
  };

  it('sends a message the chain cannot have run: no chain, no history', async () => {
    const s = setup();
    expect(await s.h.run(replayVerdict(s.h.ctx, await stored(s)))).toBe('send');
  });

  it('sends after a chain start whose earlier history never ran the code, and not after one that did', async () => {
    const s = setup();
    await deposits(s, 1);
    const message = await stored(s);
    expect(await s.h.run(replayVerdict(s.h.ctx, message))).toBe('send');
    for (const patch of CODE_RAN) {
      rewrite(
        s.h,
        (_e, route, request) =>
          route === '/transactions' && request.url.searchParams.has('end_lt'),
        (json, request) => ({
          ...json,
          transactions: [
            {
              account: s.from.toUpperCase(),
              hash: Buffer.alloc(32, 9).toString('base64'),
              lt: request.url.searchParams.get('end_lt'),
              now: 1,
              mc_block_seqno: 1,
              trace_id: Buffer.alloc(32, 9).toString('base64'),
              orig_status: 'nonexist',
              end_status: 'uninit',
              total_fees: '0',
              description: {
                type: 'ord',
                aborted: true,
                compute_ph: { skipped: true, reason: 'no_state' },
              },
              in_msg: null,
              out_msgs: [],
              ...patch,
            },
          ],
        }),
      );
      await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  it('decides nothing while the indexer is behind the freshest block at a chain start', async () => {
    const s = setup();
    await deposits(s, 1);
    const message = await stored(s);
    s.h.node.indexerLag = 1;
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'the indexer has not reached the attested block yet',
    });
  });

  it('decides nothing when the freshest state does not follow the attested one', async () => {
    const s = setup();
    await deposits(s, 3);
    const message = await stored(s);
    const attested = s.h.node.block(s.h.node.head - FINALITY_SKEW);
    expect(attested).toBeDefined();
    // The freshest state names the attested last transaction's lt with another hash.
    freshState(s, (result) => ({
      ...result,
      last_transaction_id: {
        ...(result.last_transaction_id as Json),
        hash: Buffer.alloc(32, 5).toString('base64'),
      },
    }));
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
    // An lt below the attested one that is not zero: an older chain, never a newer state.
    freshState(s, (result) => ({
      ...result,
      last_transaction_id: {
        ...(result.last_transaction_id as Json),
        lt: '1',
      },
    }));
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
  });

  it('decides nothing when the freshest chain skips the attested last transaction', async () => {
    const s = setup();
    await deposits(s, 3);
    s.h.node.inject(PAYER, s.from, GRAM, beginCell().endCell());
    s.h.node.mine();
    const message = await stored(s);
    // The attested state names an lt between two of the chain's transactions: the walk from
    // the freshest state passes below it without meeting it.
    rewrite(
      s.h,
      (_e, route, request) =>
        route === '/getAddressInformation' && request.url.searchParams.has('seqno'),
      (json) => {
        const result = json.result as Json;
        const id = result.last_transaction_id as Json;
        return {
          ...json,
          result: {
            ...result,
            last_transaction_id: { ...id, lt: (BigInt(id.lt as string) + 1n).toString() },
          },
        };
      },
    );
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      message: 'the freshest state does not follow the attested one',
    });
  });

  it('decides nothing for a wallet deleted since the attested head, or frozen now', async () => {
    const s = setup();
    await deposits(s, 1);
    const message = await stored(s);
    freshState(s, (result) => ({
      ...result,
      state: 'uninitialized',
      last_transaction_id: { lt: '0', hash: ZERO_HASH },
    }));
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'the wallet may have been reset since our message',
    });
    freshState(s, (result) => ({ ...result, state: 'frozen' }));
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses after a destruction in the window, even when ours never ran (a reset it cannot rule out)', async () => {
    const s = setup();
    const theirs = await s.request([
      nativeMessage({ to: PAYER, value: 7n, bounce: false }),
    ]);
    s.h.node.submit(theirs.boc);
    s.h.node.mine();
    // The same key's software destroys the wallet; extra currencies keep the account, so its
    // chain goes on, uninitialized.
    s.h.node.holdExtraCurrency(s.from);
    s.h.node.submit(
      v4Request(1, s.now() + 60, [
        [128 + 32, nativeMessage({ to: PAYER, value: 0n, bounce: false })],
      ]).boc,
    );
    s.h.node.mine();
    expect(s.h.node.status(s.from)).toBe('uninitialized');
    const message = await stored(s);
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'the wallet may have been reset since our message',
    });
    // A seqno read that fails is only "not known": the walk still decides.
    s.h.node.intercept = (_e, route, request) =>
      route === '/runGetMethod' && request.json<{ method: string }>().method === 'seqno'
        ? { status: 500, json: { ok: false, error: 'internal', code: 500 } }
        : undefined;
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'the wallet may have been reset since our message',
    });
  });

  it('refuses a wallet with no chain whose history shows its code ran', async () => {
    const s = setup();
    const message = await stored(s);
    rewrite(
      s.h,
      (_e, route, request) =>
        route === '/transactions' && request.url.searchParams.has('account'),
      (json) => ({
        ...json,
        transactions: [
          {
            account: s.from.toUpperCase(),
            hash: Buffer.alloc(32, 9).toString('base64'),
            lt: '500',
            now: 1,
            mc_block_seqno: 1,
            trace_id: Buffer.alloc(32, 9).toString('base64'),
            orig_status: 'active',
            end_status: 'nonexist',
            total_fees: '0',
            description: {
              type: 'ord',
              aborted: true,
              compute_ph: { skipped: true, reason: 'no_state' },
            },
            in_msg: null,
            out_msgs: [],
          },
        ],
      }),
    );
    await expect(s.h.run(replayVerdict(s.h.ctx, message))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'the wallet may have been reset since our message',
    });
  });

  it('takes a fresh endpoint behind the attested head for nothing', async () => {
    const s = setup();
    await deposits(s, 2);
    const message = await stored(s);
    // A lagging endpoint's latest state (an older block, an older chain) is not "newer".
    rewrite(
      s.h,
      (_e, route, request) =>
        route === '/getAddressInformation' && !request.url.searchParams.has('seqno'),
      (json) => json,
      (url) => url.searchParams.set('seqno', '1'),
    );
    expect(await s.h.run(replayVerdict(s.h.ctx, message))).toBe('send');
  });
});

describe('TON address history', () => {
  it('pages an address newest first with an lt cursor', async () => {
    const s = setup();
    const history = createTonHistory(s.h.ctx);
    for (const [seqno, value] of [
      [0, 1n],
      [1, 2n],
      [2, 3n],
    ] as const) {
      const { boc } = await signedBoc('v4r2', TESTNET, {
        seqno,
        validUntil: s.now() + 60,
        deploy: seqno === 0,
        messages: [nativeMessage({ to: FRESH, value, bounce: false })],
      });
      s.h.node.submit(boc);
      s.h.node.mine(2);
    }
    const first = await s.h.run(history.list(FRESH, { limit: 2 }));
    expect(first.items.map((tx) => tx.transfers[0]?.amount)).toEqual([3n, 2n]);
    expect(first.next).toMatch(/^\d+$/);
    const second = await s.h.run(history.list(FRESH, { limit: 2, cursor: first.next! }));
    expect(second.items.map((tx) => tx.transfers[0]?.amount)).toEqual([1n]);
    expect(second.next).toBeUndefined();
    await expect(
      s.h.run(history.list(FRESH, { limit: 2, cursor: 'x' })),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });

  it('pages on the page as served, and within what toncenter serves', async () => {
    const s = setup();
    const history = createTonHistory(s.h.ctx);
    for (const [seqno, value] of [
      [0, 1n],
      [1, 2n],
      [2, 3n],
    ] as const) {
      const { boc } = await signedBoc('v4r2', TESTNET, {
        seqno,
        validUntil: s.now() + 60,
        deploy: seqno === 0,
        messages: [nativeMessage({ to: FRESH, value, bounce: false })],
      });
      s.h.node.submit(boc);
      s.h.node.mine(2);
    }
    const limits: (string | null)[] = [];
    rewrite(
      s.h,
      (_e, route) => route === '/transactions',
      (json, request) => {
        limits.push(request.url.searchParams.get('limit'));
        if (request.url.searchParams.has('end_lt')) return json;
        const [newest, ...rest] = json.transactions as Json[];
        return { ...json, transactions: [{ ...newest, finality: 'pending' }, ...rest] };
      },
    );
    // The newest is not final yet, but the page was full, so it leads on.
    const first = await s.h.run(history.list(FRESH, { limit: 2 }));
    expect(first.items.map((tx) => tx.transfers[0]?.amount)).toEqual([2n]);
    expect(first.next).toMatch(/^\d+$/);
    const second = await s.h.run(history.list(FRESH, { limit: 2, cursor: first.next! }));
    expect(second.items.map((tx) => tx.transfers[0]?.amount)).toEqual([1n]);
    // toncenter v3 refuses a page above 1,000 rows: a larger limit asks for 1,000.
    const all = await s.h.run(history.list(FRESH, { limit: 5_000 }));
    expect(all.items).toHaveLength(2);
    expect(limits).toEqual(['2', '2', '1000']);
  });

  it('refuses a cursor that is no u64 logical time before any request', async () => {
    const s = setup();
    const history = createTonHistory(s.h.ctx);
    for (const cursor of ['18446744073709551616', '-1', '1'.repeat(100_000), '']) {
      await expect(
        s.h.run(history.list(FRESH, { limit: 2, cursor })),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    expect(s.h.node.served).toHaveLength(0);
    const top = await s.h.run(
      history.list(FRESH, { limit: 2, cursor: '18446744073709551615' }),
    );
    expect(top.items).toEqual([]);
  });
});
