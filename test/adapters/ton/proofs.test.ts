import { ed25519 } from '@noble/curves/ed25519';
import {
  Cell,
  SendMode,
  beginCell,
  external,
  loadMessage,
  storeMessage,
  storeMessageRelaxed,
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
  createTonHistory,
  createTonProofs,
} from '../../../src/adapters/ton/proofs';
import { REASONS } from '../../../src/adapters/ton/trace';
import { normalizedHash } from '../../../src/adapters/ton/wallets';
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
    return { ...signed, ordering: { kind: 'seqno' as const, seqno: 0n, validUntil } };
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

describe('TON proofs (lesson 17, final form)', () => {
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
    // I4: TON gives no separate `latest` evidence, so no observed `replaced` ever.
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

  it('decides nothing while the indexer lags behind the consumed seqno (Review Focus 2)', async () => {
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
    expect(
      await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
    ).toEqual({ included: false });
  });

  it('proves expiry only once every shard is past valid_until (Review Focus 5)', async () => {
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

  it('retries the attested head at the lag tolerance when a peer trails further (M1)', async () => {
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

  it('proves expiry only once the slowest of two shards is past valid_until (D9, M11)', async () => {
    const s = setup({
      node: { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 40 },
    });
    const { ordering } = await s.pay();
    await s.tick(90);
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(false);
    await s.tick(20);
    expect(await s.h.run(s.proofs.expired(ordering))).toBe(true);
  });

  it('never reads a frozen wallet as seqno 0 (I6)', async () => {
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

  it('never reads a frozen wallet as seqno 0, even once the message has expired (I6)', async () => {
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

  it("decides only once the endpoints hold the trace's last block (D10)", async () => {
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

  it("confirms a jetton transfer's wallets under the proof quorum, at the trace's last block (Task 8 carry)", async () => {
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

  describe('a lying first endpoint decides nothing (C1)', () => {
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

  describe('a relayed W5 request consumes the seqno only when proven (A23)', () => {
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

  describe('our own run that did not consume its seqno moved nothing (Task 7 carry)', () => {
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
    it('pages on the page as served, past deposits the indexer does not call final (F6-R12)', async () => {
      const s = setup();
      const ours = await s.pay();
      const theirs = await s.request([
        nativeMessage({ to: FRESH, value: 7n, bounce: false }),
      ]);
      s.h.node.submit(theirs.boc);
      s.h.node.mine();
      // A full page of deposits lands after the request that consumed our seqno.
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
      expect(
        await s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).toEqual({ included: false });
      expect(pages).toBe(2);
    });

    it('never takes a consumer the chain could not have run: its request expired first', async () => {
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
      await expect(
        s.h.run(s.proofs.includedFinal(ref(ours.hashNorm), ours.ordering, s.from)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
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
    });
  });

  describe('lookups bound to the block asked (the board: id-bound lookups)', () => {
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

  describe('the wallet state at the attested head (D9, D12, I6)', () => {
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

    it('never reads an uninitialized wallet as seqno 0 past our first slot (I6)', async () => {
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
    // F6-R12: the newest is not final yet, but the page was full, so it leads on.
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

  it('refuses a cursor that is no u64 logical time before any request (lessons 19, 20)', async () => {
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
