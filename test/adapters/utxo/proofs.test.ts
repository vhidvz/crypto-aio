import { walletAddress } from '../../../src/adapters/utxo/address';
import { txidOfHex } from '../../../src/adapters/utxo/codec';
import { PEER_SKEW, blockSource, proofSource } from '../../../src/adapters/utxo/proofs';
import type { ScanFilter } from '../../../src/core/driver/types';
import type { OrderingData } from '../../../src/core/model/ordering';
import { utxoHarness, type Harness, type HarnessOptions } from './support/harness';
import { malleate, signedLegacySpend, signedSpend } from './support/tx';
import { OTHER_PUBKEY, REGTEST, TEST_KEY, TEST_PUBKEY } from './support/vectors';

const PEER_SKEW_NUMBER = Number(PEER_SKEW);
const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const ref = (id: string) => ({ id, idKind: 'txid' as const, canonical: true });
const inputs = (...outpoints: string[]): OrderingData => ({
  kind: 'inputs',
  inputs: outpoints,
});

type Json = Record<string, unknown>;
const jsonOf = (reply: unknown): Json => (reply as { json: Json }).json;
/** An honest answer of endpoint `a`, read around the intercepts. */
const get = (h: Harness, path: string) =>
  h.node.fetch.fetch(`https://esplora-a.test/api${path}`);
const getJson = async (h: Harness, path: string): Promise<Json> =>
  (await (await get(h, path)).json()) as Json;

/** A funded wallet, one broadcast spend of its output, and the proof source. */
async function withSpend(options: HarnessOptions = {}) {
  const h = await utxoHarness(options);
  const outpoint = h.node.fund(OWN.address, 100_000n);
  const [txid] = outpoint.split(':') as [string];
  const spent = h.node.submit(
    signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE.script, 90_000n]]),
  );
  return { ...h, proofs: proofSource(h.ctx), outpoint, spent };
}

describe('proofs (lessons 14, 16, 17)', () => {
  it('attests the final head: one endpoint head, less the peer skew, then N-1 blocks', async () => {
    const h = await withSpend();
    h.node.mine(8);
    h.calls.length = 0;
    const head = await h.run(h.proofs.finalizedHead());
    expect(head.height).toBe(BigInt(h.node.height) - PEER_SKEW - 5n);
    expect(
      h.calls.map((c) => [c.request.route, c.options.purpose, c.options.quorum ?? null]),
    ).toEqual([
      ['/blocks/tip/height', 'monitor', null],
      ['/blocks/tip/height', 'proof', 'proof'],
      ['/block-height/:height', 'proof', 'proof'],
    ]);
    // The head is attested with a monotone predicate ("I hold this block"), never compared whole.
    const key = h.calls[1]?.options.quorumKey;
    expect(key?.(String(h.node.height + 3))).toBe(true);
    expect(key?.(String(h.node.height - PEER_SKEW_NUMBER - 1))).toBe(false);
    expect(await h.run(h.proofs.blockHash(head.height, 'finalized'))).toBe(head.hash);
    expect(
      await h.run(h.proofs.blockHash(BigInt(h.node.height - 4), 'finalized')),
    ).toBeNull();
    expect(await h.run(h.proofs.blockHash(99n, 'latest'))).toBeNull();
  });

  it('proves inclusion only at final depth; found but not final decides nothing (C1)', async () => {
    const h = await withSpend();
    // In the mempool, no conflicting final spend: retryable, never "not included".
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    h.node.mine(5); // in a block, 5 confirmations: not final yet
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    h.node.mine(1);
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({ included: true, success: true, blockHeight: 2n, txHash: h.spent });
    const txRead = h.calls.filter((c) => c.request.route === '/tx/:txid').at(-1);
    expect(txRead?.options).toMatchObject({ purpose: 'proof', quorum: 'proof' });
    expect(txRead?.options.quorumKey).toBeDefined();
  });

  it('never answers "not included" for a transaction the indexer does not know (lesson 16)', async () => {
    const h = await utxoHarness();
    const outpoint = h.node.fund(OWN.address, 100_000n);
    h.node.mine(6);
    await expect(
      h.run(
        proofSource(h.ctx).includedFinal(
          ref('cd'.repeat(32)),
          inputs(outpoint),
          OWN.address,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('answers "not included" only for a final spend by another transaction (C1)', async () => {
    const h = await withSpend();
    h.node.mine(6);
    expect(
      await h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'finalized')),
    ).toBe(true);
    h.calls.length = 0;
    expect(
      await h.run(
        h.proofs.includedFinal(ref('cd'.repeat(32)), inputs(h.outpoint), OWN.address),
      ),
    ).toEqual({ included: false });
    // A segwit sender cannot be malleated, so no spender bytes are ever read for it (C2).
    expect(h.calls.some((c) => c.request.route === '/tx/:txid/hex')).toBe(false);
  });

  it('proves a final malleated copy of our p2pkh Attempt included, under its own txid (C2)', async () => {
    const h = await utxoHarness();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const outpoint = h.node.fund(legacy.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    const prev = h.node.transaction(txid)!.toHex();
    const ours = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, prev]],
      [[PAYEE.script, 90_000n]],
    );
    const copy = malleate(ours, 'junk-push');
    h.node.mine(1, { extra: [copy] }); // a miner's copy; ours never reached a mempool
    h.node.mine(5);
    const proofs = proofSource(h.ctx);
    const oursId = txidOfHex(ours);
    expect(
      await h.run(proofs.includedFinal(ref(oursId), inputs(outpoint), legacy.address)),
    ).toMatchObject({
      included: true,
      success: true,
      blockHeight: 2n,
      txHash: txidOfHex(copy),
    });
    const hexRead = h.calls.find((c) => c.request.route === '/tx/:txid/hex');
    expect(hexRead?.options).toMatchObject({ purpose: 'proof', quorum: 'proof' });
    // A different payment from the same input is another transaction: ours is dead.
    const other = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, prev]],
      [[PAYEE.script, 80_000n]],
    );
    expect(
      await h.run(
        proofs.includedFinal(ref(txidOfHex(other)), inputs(outpoint), legacy.address),
      ),
    ).toEqual({ included: false });
  });

  it('counts a mempool spend as consumed at latest only', async () => {
    const h = await withSpend();
    expect(
      await h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'latest')),
    ).toBe(true);
    expect(
      await h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'finalized')),
    ).toBe(false);
    expect(await h.run(h.proofs.expired(inputs(h.outpoint)))).toBe(false);
  });

  it('decides nothing while a second endpoint has not reached the height of the fact', async () => {
    const h = await withSpend({ endpoints: ['a', 'b'] });
    h.node.mine(6); // the spend is in block 2 and final at height 7
    h.node.setLag('b', 1);
    // The head trails by the peer skew, so a one-block lag still attests it.
    expect((await h.run(h.proofs.finalizedHead())).height).toBe(0n);
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    h.node.setLag('b', 0);
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({ included: true, blockHeight: 2n });
  });

  it('treats a stale inclusion as undecided, never as "not included"', async () => {
    const h = await withSpend();
    h.node.mine(6);
    const real = await h.run(
      h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address),
    );
    expect(real).toMatchObject({ included: true });
    // The endpoint still reports the transaction in a block that is no longer at its height.
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith('/block-height/2')
        ? { text: 'ee'.repeat(32) }
        : undefined,
    );
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('treats a stale spend as undecided, never as "not included"', async () => {
    const h = await withSpend();
    h.node.mine(6);
    // The spend view names a block that is not the block at the spend's height.
    h.node.intercept('a', (request, _signal, honest) => {
      if (!request.url.pathname.includes('/outspend/')) return undefined;
      const spend = (honest() as { json: Json }).json;
      const status = { ...(spend.status as Json), block_hash: 'ee'.repeat(32) };
      return { json: { ...spend, status } };
    });
    await expect(
      h.run(
        h.proofs.includedFinal(ref('cd'.repeat(32)), inputs(h.outpoint), OWN.address),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    await expect(
      h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'finalized')),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });
});

describe('every error on a proof read decides nothing (lesson 18, widened)', () => {
  it('turns a CDN or proxy 4xx on a proof read into a retryable decide-nothing', async () => {
    const h = await withSpend();
    h.node.mine(6);
    const refusal = { status: 400, text: 'Bad Request' };
    // The head read behind the final-depth attestation.
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith('/blocks/tip/height') ? refusal : undefined,
    );
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    // The spend read behind "not included" (an Attempt the indexer does not know).
    h.node.intercept('a', (request) =>
      request.url.pathname.includes('/outspend/')
        ? { status: 410, text: 'Gone' }
        : undefined,
    );
    await expect(
      h.run(
        h.proofs.includedFinal(ref('cd'.repeat(32)), inputs(h.outpoint), OWN.address),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    await expect(
      h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'finalized')),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    // An auth refusal (PROVIDER_MISCONFIGURED) on the transaction read decides nothing too.
    h.node.intercept('a', (request) =>
      request.url.pathname.includes('/tx/')
        ? { status: 403, text: 'Forbidden' }
        : undefined,
    );
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    h.node.clearIntercept('a');
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({ included: true });
  });
});

describe('block source', () => {
  it('pages a block of more than 25 transactions and filters by address', async () => {
    const h = await utxoHarness();
    for (let i = 0; i < 30; i++) {
      h.node.fund(i === 7 ? PAYEE.address : OWN.address, 1_000n, { mempool: true });
    }
    h.node.mine();
    const blocks = blockSource(h.ctx);
    const header = await h.run(blocks.header(1n));
    expect(header).toMatchObject({ height: 1n, parentHash: h.node.options.genesisHash });
    expect(await h.run(blocks.transactions(header!))).toHaveLength(31);
    expect(
      await h.run(blocks.transactions(header!, { addresses: [PAYEE.address] })),
    ).toHaveLength(1);
    expect(await h.run(blocks.header(5n))).toBeNull();
    expect(h.calls.every((c) => c.options.purpose === 'monitor')).toBe(true);
  });

  it('fails with a retryable PROVIDER_INCONSISTENT when the block was reorged away', async () => {
    const h = await utxoHarness();
    h.node.mine(2);
    const blocks = blockSource(h.ctx);
    const header = await h.run(blocks.header(2n));
    h.node.reorg(1);
    h.node.mine(1);
    await expect(h.run(blocks.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('refuses a header whose block says another height (I2)', async () => {
    const h = await utxoHarness();
    h.node.mine(2);
    const base = 'https://esplora-a.test/api';
    const hash = await (await h.node.fetch.fetch(`${base}/block-height/2`)).text();
    const block = (await (
      await h.node.fetch.fetch(`${base}/block/${hash}`)
    ).json()) as Record<string, unknown>;
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/block/${hash}`)
        ? { json: { ...block, height: 1 } }
        : undefined,
    );
    await expect(h.run(blockSource(h.ctx).header(2n))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });
});

describe('"not included" needs an attested final spend by another transaction (C1, F3-R8)', () => {
  it('decides nothing while the spend view names our own final txid and the transaction view does not (R76)', async () => {
    const h = await withSpend();
    h.node.mine(6);
    // A backend that never indexed our transaction, then one serving it from a stale store.
    const answers = [
      () => ({ status: 404, text: 'Transaction not found' }),
      (honest: Json) => ({ json: { ...honest, status: { confirmed: false } } }),
    ];
    for (const answer of answers) {
      h.node.intercept('a', (request, _signal, honest) =>
        request.url.pathname.endsWith(`/tx/${h.spent}`)
          ? answer(jsonOf(honest()))
          : undefined,
      );
      expect(
        await h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, 'finalized')),
      ).toBe(true);
      await expect(
        h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
    h.node.clearIntercept('a');
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({ included: true, txHash: h.spent });
  });

  it('keeps a transient own spend undecided: a stale outspend, then a fresh one naming ours (F3-R9)', async () => {
    const h = await withSpend();
    const undecided = { code: 'PROVIDER_UNAVAILABLE', retryable: true };
    const slot = (level: 'latest' | 'finalized') =>
      h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, level));
    const included = () =>
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address));
    // In a mempool, then in a block that is not final yet.
    for (const blocks of [0, 1]) {
      if (blocks > 0) h.node.mine(blocks);
      h.node.intercept('a', (request) =>
        request.url.pathname.includes('/outspend/')
          ? { json: { spent: false } }
          : undefined,
      );
      expect(await slot('latest')).toBe(false);
      expect(await slot('finalized')).toBe(false);
      await expect(included()).rejects.toMatchObject(undecided);
      h.node.clearIntercept('a');
      // Fresh: our own spend consumes the input at latest only. The monitor can record that
      // as an observed `replaced` at most, never a proven one: nothing here is terminal.
      expect(await slot('latest')).toBe(true);
      expect(await slot('finalized')).toBe(false);
      await expect(included()).rejects.toMatchObject(undecided);
    }
    h.node.mine(5);
    expect(await included()).toMatchObject({ included: true, txHash: h.spent });
  });

  it('never proves a confirmed-then-reorged transaction final; only a final conflict proves it dead', async () => {
    const h = await withSpend();
    const included = () =>
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address));
    const slot = (level: 'latest' | 'finalized') =>
      h.run(h.proofs.slotConsumed(inputs(h.outpoint), OWN.address, level));
    h.node.mine(6);
    expect(await included()).toMatchObject({ included: true, blockHeight: 2n });
    h.node.reorg(6); // its block is gone, so it is back in the mempool,
    h.node.evict(h.spent); // and then evicted from it
    h.node.mine(6);
    // Full-mode electrs still serves it, unconfirmed, from its store; its input is unspent.
    expect((await getJson(h, `/tx/${h.spent}`)).status).toEqual({ confirmed: false });
    await expect(included()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(await slot('finalized')).toBe(false);
    expect(await slot('latest')).toBe(false);
    // Another transaction spends its input: not final yet, then final.
    const [txid] = h.outpoint.split(':') as [string];
    h.node.submit(
      signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE.script, 80_000n]]),
    );
    h.node.mine(5);
    await expect(included()).rejects.toMatchObject({ retryable: true });
    h.node.mine(1);
    expect(await included()).toEqual({ included: false });
  });

  it('decides nothing when the transaction view puts ours in a block but a final conflict spends its input', async () => {
    const h = await withSpend();
    const [txid] = h.outpoint.split(':') as [string];
    const conflict = h.node.submit(
      signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE.script, 80_000n]]),
    );
    h.node.mine(6);
    const tip = await (await get(h, `/block-height/${h.node.height}`)).text();
    const body = await getJson(h, `/tx/${conflict}`);
    // One view says ours is in the newest block (not final yet); the spend view says the
    // conflict is final. Both cannot hold: the views contradict each other.
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${h.spent}`)
        ? {
            json: {
              ...body,
              txid: h.spent,
              status: {
                confirmed: true,
                block_height: h.node.height,
                block_hash: tip,
                block_time: 0,
              },
            },
          }
        : undefined,
    );
    await expect(
      h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    h.node.clearIntercept('a');
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ included: false });
  });

  it("decides nothing when a spender's bytes are junk or another transaction's (C2)", async () => {
    const h = await utxoHarness();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const outpoint = h.node.fund(legacy.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    const prev = h.node.transaction(txid)!.toHex();
    const ours = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, prev]],
      [[PAYEE.script, 90_000n]],
    );
    const copy = malleate(ours, 'high-s');
    h.node.mine(1, { extra: [copy] });
    h.node.mine(5);
    const proofs = proofSource(h.ctx);
    const included = () =>
      h.run(proofs.includedFinal(ref(txidOfHex(ours)), inputs(outpoint), legacy.address));
    // Provider data never becomes the codec's INVALID_INTENT, nor "not included": junk
    // fails the quorum key (a disagreement), and another transaction's bytes fail the id.
    for (const text of ['zz', prev]) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/tx/${txidOfHex(copy)}/hex`)
          ? { text }
          : undefined,
      );
      await expect(included()).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    h.node.clearIntercept('a');
    expect(await included()).toMatchObject({ included: true, txHash: txidOfHex(copy) });
  });

  it('decides nothing when two endpoints disagree on any fact of the verdict (lesson 2)', async () => {
    const h = await withSpend({ endpoints: ['a', 'b'] });
    h.node.mine(6);
    const other = 'cd'.repeat(32);
    const rewrite = (json: Json, change: Json): Json => ({ ...json, ...change });
    const status = (json: Json, change: Json): Json =>
      rewrite(json, { status: rewrite(json.status as Json, change) });
    // Endpoint b lies about one fact the verdict reads; a tells the truth. The spend view
    // decides an Attempt the index does not know (its input spent by h.spent); the
    // transaction view decides ours.
    const spend = (path: string) => path.includes('/outspend/');
    const ours = (path: string) => path.endsWith(`/tx/${h.spent}`);
    const lies: [(path: string) => boolean, (json: Json) => Json, string][] = [
      [spend, (json) => rewrite(json, { txid: other }), other],
      [spend, (json) => status(json, { block_hash: 'ee'.repeat(32) }), other],
      [spend, (json) => status(json, { block_height: 3 }), other],
      [ours, (json) => status(json, { block_hash: 'ee'.repeat(32) }), h.spent],
      [ours, (json) => status(json, { block_height: 3 }), h.spent],
    ];
    for (const [matches, lie, id] of lies) {
      h.node.intercept('b', (request, _signal, honest) =>
        matches(request.url.pathname) ? { json: lie(jsonOf(honest())) } : undefined,
      );
      await expect(
        h.run(h.proofs.includedFinal(ref(id), inputs(h.outpoint), OWN.address)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    }
    h.node.clearIntercept('b');
    expect(
      await h.run(h.proofs.includedFinal(ref(other), inputs(h.outpoint), OWN.address)),
    ).toEqual({ included: false });
  });

  it('never sends a height outside the chain (I2)', async () => {
    const h = await utxoHarness();
    h.calls.length = 0;
    expect(await h.run(proofSource(h.ctx).blockHash(-1n, 'latest'))).toBeNull();
    expect(await h.run(proofSource(h.ctx).blockHash(-1n, 'finalized'))).toBeNull();
    expect(await h.run(blockSource(h.ctx).header(-1n))).toBeNull();
    expect(await h.run(blockSource(h.ctx).header(2n ** 53n))).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

/** A block at height 1 of a coinbase and 30 funding transactions (two pages). */
async function busyBlock(payeeAt = 7) {
  const h = await utxoHarness();
  let payee = '';
  for (let i = 0; i < 30; i++) {
    const outpoint = h.node.fund(i === payeeAt ? PAYEE.address : OWN.address, 1_000n, {
      mempool: true,
    });
    if (i === payeeAt) payee = outpoint.split(':')[0] as string;
  }
  h.node.mine();
  const blocks = blockSource(h.ctx);
  const header = (await h.run(blocks.header(1n)))!;
  const first = (await (await get(h, `/block/${header.hash}/txs/0`)).json()) as Json[];
  return { ...h, blocks, header, first, payee };
}

describe('block source: every page bound to its block (I2, lenient readers)', () => {
  it('refuses pages that repeat, drop or add a transaction', async () => {
    const h = await busyBlock();
    const second = `/block/${h.header.hash}/txs/25`;
    // Six of page one again (the count still adds up), one of its own short, one extra.
    const pages: ((own: Json[]) => Json[])[] = [
      () => h.first.slice(0, 6),
      (own) => own.slice(0, 5),
      (own) => [...own, { ...h.first[3], txid: 'ab'.repeat(32) }],
    ];
    for (const page of pages) {
      h.node.intercept('a', (request, _signal, honest) =>
        request.url.pathname.endsWith(second)
          ? { json: page((honest() as { json: Json[] }).json) }
          : undefined,
      );
      await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
    h.node.clearIntercept('a');
    expect(await h.run(h.blocks.transactions(h.header))).toHaveLength(31);
  });

  it('decides nothing on a page transaction that is not confirmed in that block', async () => {
    const h = await busyBlock();
    const genesis = h.node.options.genesisHash;
    for (const status of [
      { confirmed: false },
      { confirmed: true, block_height: 0, block_hash: genesis, block_time: 0 },
    ]) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/block/${h.header.hash}/txs/0`)
          ? { json: h.first.map((tx, i) => (i === 5 ? { ...tx, status } : tx)) }
          : undefined,
      );
      await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
  });

  it('catches a reorg while paging: the block hash is checked again after the pages', async () => {
    const h = await busyBlock();
    h.node.intercept('a', (request, _signal, honest) => {
      if (!request.url.pathname.endsWith(`/block/${h.header.hash}/txs/25`))
        return undefined;
      const page = honest(); // the old block's last page, then the block is replaced
      h.node.reorg(1);
      h.node.mine(1);
      return page;
    });
    await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.clearIntercept('a');
    expect(await h.run(h.blocks.header(1n))).not.toMatchObject({ hash: h.header.hash });
  });

  it('decides nothing on a page the endpoint does not have (a lagging or load-balanced backend)', async () => {
    const h = await busyBlock();
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/block/${h.header.hash}/txs/25`)
        ? { status: 404, text: 'Block not found' }
        : undefined,
    );
    await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('bounds the transaction count by the chain before paging', async () => {
    const h = await busyBlock();
    const block = await getJson(h, `/block/${h.header.hash}`);
    // No block is empty (a coinbase), and none holds more than 1,000,000 transactions.
    for (const count of [0, 1_000_001]) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/block/${h.header.hash}`)
          ? { json: { ...block, tx_count: count } }
          : undefined,
      );
      h.calls.length = 0;
      await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      expect(h.calls.some((c) => c.request.route === '/block/:hash/txs/:start')).toBe(
        false,
      );
    }
  });

  it('pages past a first page that holds no watched transaction (page on the raw page)', async () => {
    const h = await busyBlock(29);
    expect(h.node.blockTxids(1).indexOf(h.payee)).toBeGreaterThanOrEqual(25);
    const found = await h.run(
      h.blocks.transactions(h.header, { addresses: [PAYEE.address] }),
    );
    expect(found.map((tx) => tx.id)).toEqual([h.payee]);
  });

  it('takes empty filter lists as no filter; a Bitcoin block has no token transfers', async () => {
    const h = await busyBlock();
    expect(await h.run(h.blocks.transactions(h.header, { addresses: [] }))).toHaveLength(
      31,
    );
    const all = (assets: NonNullable<ScanFilter['assets']>) =>
      h.run(h.blocks.transactions(h.header, { assets }));
    expect(await all([])).toHaveLength(31);
    expect(await all(['native'])).toHaveLength(31);
    expect(await all([{ standard: 'erc20', contract: 'x' }])).toEqual([]);
  });

  it("keeps a watched address's spend to outputs no address names (filtered by script)", async () => {
    const h = await utxoHarness();
    const outpoint = h.node.fund(OWN.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    // A witness v2 program: valid, but no address this library names.
    const future = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(7));
    const spend = signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[future, 90_000n]]);
    h.node.mine(1, { extra: [spend] });
    const blocks = blockSource(h.ctx);
    const header = (await h.run(blocks.header(2n)))!;
    const watched = await h.run(
      blocks.transactions(header, { addresses: [OWN.address] }),
    );
    expect(watched.map((tx) => tx.id)).toEqual([txidOfHex(spend)]);
    expect(watched[0]).toMatchObject({ decoding: 'partial', transfers: [] });
    expect(
      await h.run(blocks.transactions(header, { addresses: [PAYEE.address] })),
    ).toEqual([]);
  });
});
