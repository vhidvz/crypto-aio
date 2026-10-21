import { walletAddress } from '../../../src/adapters/utxo/address';
import { BITCOIN_CHAIN } from '../../../src/adapters/utxo/chains';
import { txidOfHex } from '../../../src/adapters/utxo/codec';
import { MONITOR } from '../../../src/adapters/utxo/context';
import { decodeTransaction } from '../../../src/adapters/utxo/decode';
import { EsploraClient, parseTx } from '../../../src/adapters/utxo/esplora';
import { utxoNetworkConfig } from '../../../src/adapters/utxo/network';
import { PEER_SKEW, blockSource, proofSource } from '../../../src/adapters/utxo/proofs';
import { readBlock } from '../../../src/adapters/utxo/rawblock';
import { bitcoin, type Transaction } from '../../../src/adapters/utxo/sdk';
import type { ScanFilter } from '../../../src/core/driver/types';
import { EventBus } from '../../../src/core/events/bus';
import { noopLogger } from '../../../src/core/events/logger';
import type { NetworkInfo } from '../../../src/core/model/chain';
import type { OrderingData } from '../../../src/core/model/ordering';
import { HttpTransport } from '../../../src/core/transport/http-transport';
import { concatBytes, fromHex, toHex } from '../../../src/core/util/bytes';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { FakeFetch } from '../../../src/testing/fake-fetch';
import { utxoHarness, type Harness, type HarnessOptions } from './support/harness';
import { SIGNET_70000 } from './support/signet';
import { malleate, signedLegacySpend, signedSpend } from './support/tx';
import {
  BIP173_PUBKEY,
  OTHER_PUBKEY,
  REGTEST,
  TEST_KEY,
  TEST_PUBKEY,
} from './support/vectors';

const PEER_SKEW_NUMBER = Number(PEER_SKEW);
const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const STRANGER = walletAddress(fromHex(BIP173_PUBKEY), 'p2wpkh', REGTEST);
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

  it('proves inclusion only at final depth; found but not final decides nothing', async () => {
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

  it('never answers "not included" for a transaction the indexer does not know', async () => {
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

  it('answers "not included" only for a final spend by another transaction', async () => {
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
    // A segwit sender cannot be malleated, so no spender bytes are ever read for it.
    expect(h.calls.some((c) => c.request.route === '/tx/:txid/hex')).toBe(false);
  });

  it('proves a final malleated copy of our p2pkh Attempt included, under its own txid', async () => {
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

  // The copy check comes first: ours in a block while another transaction's final spend
  // of its input exists is otherwise a contradiction that decides nothing.
  it('proves a final malleated copy included even while the transaction view puts ours in a block not yet final', async () => {
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
    h.node.mine(1, { extra: [copy] });
    h.node.mine(5);
    const oursId = txidOfHex(ours);
    // The transaction view puts ours in the tip block, which is not final: it decides
    // nothing, and the final copy of ours in its input's spend is our payment.
    const tip = await (await get(h, `/block-height/${h.node.height}`)).text();
    const view = await getJson(h, `/tx/${txidOfHex(copy)}`);
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${oursId}`)
        ? {
            json: {
              ...view,
              txid: oursId,
              status: { confirmed: true, block_height: h.node.height, block_hash: tip },
            },
          }
        : undefined,
    );
    const proofs = proofSource(h.ctx);
    expect(
      await h.run(proofs.includedFinal(ref(oursId), inputs(outpoint), legacy.address)),
    ).toMatchObject({ included: true, blockHeight: 2n, txHash: txidOfHex(copy) });
    expect(h.calls.map((c) => c.request.path)).toContain(`/tx/${oursId}`);
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

describe('every error on a proof read decides nothing', () => {
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
  it('reads a block of more than 25 transactions and filters by address', async () => {
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

  it('refuses a header whose block says another height', async () => {
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

describe('"not included" needs an attested final spend by another transaction', () => {
  it('decides nothing while the spend view names our own final txid and the transaction view does not', async () => {
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

  it('keeps a transient own spend undecided: a stale outspend, then a fresh one naming ours', async () => {
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

  it("decides nothing when a spender's bytes are junk or another transaction's", async () => {
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

  it('compares block hashes as parsed, so a trailing newline never splits the quorum', async () => {
    const h = await withSpend({ endpoints: ['a', 'b'] });
    h.node.mine(8);
    const serve = (edit: (text: string) => string) =>
      h.node.intercept('b', (request, _signal, honest) => {
        if (!request.url.pathname.includes('/block-height/')) return undefined;
        const reply = honest() as { status?: number; text: string };
        return reply.status === undefined ? { text: edit(reply.text) } : reply;
      });
    serve((hash) => `${hash}\n`);
    const head = await h.run(h.proofs.finalizedHead());
    expect(await h.run(h.proofs.blockHash(head.height, 'finalized'))).toBe(head.hash);
    expect(
      await h.run(h.proofs.includedFinal(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({
      included: true,
      blockHash: await h.run(h.proofs.blockHash(2n, 'finalized')),
    });
    const keyed = h.calls.filter(
      (c) => c.request.route === '/block-height/:height' && c.options.quorum === 'proof',
    );
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((c) => c.options.quorumKey !== undefined)).toBe(true);
    // Another hash is still a disagreement, which decides nothing.
    serve(() => 'ee'.repeat(32));
    await expect(h.run(h.proofs.finalizedHead())).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('decides nothing when two endpoints disagree on any fact of the verdict', async () => {
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

  it('never sends a height outside the chain', async () => {
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

const WATCHED: ScanFilter = { addresses: [PAYEE.address] };

describe('block source: every read bound to the block (its bytes, its pages, its hash after them)', () => {
  it('refuses pages that repeat, drop or add a transaction', async () => {
    const h = await busyBlock();
    const second = `/block/${h.header.hash}/txs/25`;
    // Six of page one again (the count still adds up), one of its own short, one extra.
    const pages: [(own: Json[]) => Json[], string][] = [
      [() => h.first.slice(0, 6), 'PROVIDER_INCONSISTENT'],
      [(own) => own.slice(0, 5), 'PROVIDER_UNAVAILABLE'],
      [
        (own) => [...own, { ...h.first[3], txid: 'ab'.repeat(32) }],
        'PROVIDER_UNAVAILABLE',
      ],
    ];
    for (const [page, code] of pages) {
      h.node.intercept('a', (request, _signal, honest) =>
        request.url.pathname.endsWith(second)
          ? { json: page((honest() as { json: Json[] }).json) }
          : undefined,
      );
      await expect(h.run(h.blocks.transactions(h.header, WATCHED))).rejects.toMatchObject(
        {
          code,
          retryable: true,
        },
      );
    }
    h.node.clearIntercept('a');
    expect(await h.run(h.blocks.transactions(h.header, WATCHED))).toHaveLength(1);
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
      await expect(h.run(h.blocks.transactions(h.header, WATCHED))).rejects.toMatchObject(
        {
          code: 'PROVIDER_INCONSISTENT',
          retryable: true,
        },
      );
    }
  });

  it('catches a reorg while reading: the block hash is checked again after the reads', async () => {
    for (const [route, filter] of [
      ['/txs/25', WATCHED],
      ['/raw', undefined],
    ] as const) {
      const h = await busyBlock();
      h.node.intercept('a', (request, _signal, honest) => {
        if (!request.url.pathname.endsWith(`/block/${h.header.hash}${route}`))
          return undefined;
        const answer = honest(); // the old block's bytes or page, then it is replaced
        h.node.reorg(1);
        h.node.mine(1);
        return answer;
      });
      await expect(h.run(h.blocks.transactions(h.header, filter))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
      h.node.clearIntercept('a');
      expect(await h.run(h.blocks.header(1n))).not.toMatchObject({ hash: h.header.hash });
    }
  });

  it('decides nothing on a block or page the endpoint does not have (a lagging or load-balanced backend)', async () => {
    for (const [route, filter] of [
      ['/txs/25', WATCHED],
      ['/raw', undefined],
    ] as const) {
      const h = await busyBlock();
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/block/${h.header.hash}${route}`)
          ? { status: 404, text: 'Block not found' }
          : undefined,
      );
      await expect(h.run(h.blocks.transactions(h.header, filter))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
  });

  it('reads no page of bytes that do not decode as a block', async () => {
    const h = await busyBlock();
    const raw = h.node.rawBlock(1);
    // No transaction (not even a coinbase), more transactions than the bytes hold, a byte
    // after the last one: bitcoind decodes none of them.
    for (const bytes of [
      concatBytes(raw.subarray(0, 80), Uint8Array.of(0)),
      concatBytes(raw.subarray(0, 80), Uint8Array.of(32), raw.subarray(81)),
      concatBytes(raw, Uint8Array.of(0)),
    ]) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith('/raw') ? new Response(bytes) : undefined,
      );
      h.calls.length = 0;
      await expect(h.run(h.blocks.transactions(h.header, WATCHED))).rejects.toMatchObject(
        {
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        },
      );
      expect(h.calls.some((c) => c.request.route === '/block/:hash/txs/:start')).toBe(
        false,
      );
    }
  });

  it('pages past a first page that holds no watched transaction (page on the raw page)', async () => {
    const h = await busyBlock(29);
    expect(h.node.blockTxids(1).indexOf(h.payee)).toBeGreaterThanOrEqual(25);
    const found = await h.run(h.blocks.transactions(h.header, WATCHED));
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
    // A filter naming no native asset: nothing to read.
    h.calls.length = 0;
    expect(await all([{ standard: 'erc20', contract: 'x' }])).toEqual([]);
    expect(h.calls).toEqual([]);
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

/**
 * Block 2: a payment from OWN to PAYEE with change (a segwit spend of a block-1 output), a
 * spend of that payment's change in the same block, and a funding transaction to a stranger.
 */
async function paymentBlock() {
  const h = await utxoHarness();
  const outpoint = h.node.fund(OWN.address, 100_000n);
  const [parent] = outpoint.split(':') as [string];
  const payment = signedSpend(
    TEST_KEY,
    [[parent, 0, 100_000n]],
    [
      [PAYEE.script, 60_000n],
      [OWN.script, 39_000n],
    ],
  );
  const paid = h.node.submit(payment);
  const child = h.node.submit(
    signedSpend(TEST_KEY, [[paid, 1, 39_000n]], [[OWN.script, 38_000n]]),
  );
  h.node.fund(STRANGER.address, 5_000n, { mempool: true });
  h.node.mine();
  expect(h.node.blockTxids(2)).toContain(child);
  const blocks = blockSource(h.ctx);
  const header = (await h.run(blocks.header(2n)))!;
  return { ...h, blocks, header, parent, paid, child };
}

/** Endpoint `a` answers `bytes` for the block's raw route. */
const serveRaw = (h: Harness, bytes: Uint8Array) =>
  h.node.intercept('a', (request) =>
    request.url.pathname.endsWith('/raw') ? new Response(bytes) : undefined,
  );

/** The block at `height` of the node, edited by `edit`, its merkle root recomputed or not. */
function forged(
  h: Harness,
  height: number,
  edit: (txs: Transaction[]) => void,
  rehash: boolean,
): Uint8Array {
  const block = bitcoin.Block.fromBuffer(h.node.rawBlock(height));
  edit(block.transactions!);
  if (rehash) block.merkleRoot = bitcoin.Block.calculateMerkleRoot(block.transactions!);
  return block.toBuffer();
}

describe("block source: every transaction delivered is the block's own (bound to its header)", () => {
  it('decodes a block from its bytes exactly as its pages show it', async () => {
    const h = await paymentBlock();
    const page = (await getJson(h, `/block/${h.header.hash}/txs/0`)) as unknown as Json[];
    const expected = page.map((tx) =>
      decodeTransaction(parseTx(tx), h.ctx.config.address),
    );
    expect(await h.run(h.blocks.transactions(h.header))).toEqual(expected);
    expect(
      await h.run(h.blocks.transactions(h.header, { addresses: [PAYEE.address] })),
    ).toEqual(expected.filter((tx) => tx.id === h.paid));
    const coinbase = expected[0]!;
    expect(coinbase.details).toMatchObject({
      vout: [{ type: 'v0_p2wsh' }, { type: 'op_return', value: 0n }],
    });
  });

  it('decodes a real block from its bytes as its real Esplora page shows it (signet 70000)', async () => {
    const fake = new FakeFetch().route('https://esplora.test/api', (request) => {
      const path = request.url.pathname.slice('/api'.length);
      if (path === `/block-height/${SIGNET_70000.height}`)
        return { text: SIGNET_70000.hash };
      if (path === `/block/${SIGNET_70000.hash}`) return { json: SIGNET_70000.header };
      if (path === `/block/${SIGNET_70000.hash}/raw`) {
        return new Response(fromHex(SIGNET_70000.raw));
      }
      if (path === `/block/${SIGNET_70000.hash}/txs/0`)
        return { json: SIGNET_70000.page };
      const parent = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path)?.[1];
      const hex = parent === undefined ? undefined : SIGNET_70000.parents[parent];
      return hex ? { text: hex } : { status: 404, text: 'not found' };
    });
    const clock = new FakeClock();
    const transport = new HttpTransport(
      [{ name: 's', url: 'https://esplora.test/api' }],
      {
        clock,
        events: new EventBus(clock, noopLogger),
        log: noopLogger,
        id: 'signet',
        random: () => 0.5,
        options: { fetch: fake.fetch, baseDelayMs: 1, maxDelayMs: 2 },
      },
    );
    const network = BITCOIN_CHAIN.networks.signet as NetworkInfo;
    const config = utxoNetworkConfig(BITCOIN_CHAIN, network, {});
    const blocks = blockSource({
      esplora: new EsploraClient(transport, transport),
      chain: BITCOIN_CHAIN,
      network,
      config,
      log: noopLogger,
    });
    const run = <T>(promise: Promise<T>) => drive(clock, promise, 100);
    const header = (await run(blocks.header(BigInt(SIGNET_70000.height))))!;
    const expected = SIGNET_70000.page.map((tx) =>
      decodeTransaction(parseTx(tx), config.address),
    );
    expect(await run(blocks.transactions(header))).toEqual(expected);
    // The miner's address is paid by the coinbase only; every other transaction spends from
    // and pays one anyone-can-spend p2wsh.
    const [miner, p2wsh] = [expected[0]!, expected[1]!].map((tx) => tx.transfers[0]!.to);
    expect(await run(blocks.transactions(header, { addresses: [miner!] }))).toEqual([
      expected[0],
    ]);
    expect(await run(blocks.transactions(header, { addresses: [p2wsh!] }))).toEqual(
      expected.slice(1),
    );
  });

  it('never delivers a forged output: bytes that do not hash to the block decide nothing', async () => {
    const h = await paymentBlock();
    // The stranger's funding transaction pays PAYEE instead: under the old header (its
    // merkle root no longer commits to the transactions), then under a new one (another hash).
    for (const rehash of [false, true]) {
      serveRaw(
        h,
        forged(
          h,
          2,
          (txs) => {
            const funding = txs.find((tx) => tx.outs[0]!.value === 5_000n)!;
            funding.outs[0]!.script = PAYEE.script;
          },
          rehash,
        ),
      );
      for (const filter of [undefined, WATCHED]) {
        await expect(
          h.run(h.blocks.transactions(h.header, filter)),
        ).rejects.toMatchObject({
          code: 'PROVIDER_INCONSISTENT',
          retryable: true,
        });
      }
    }
    h.node.clearIntercept('a');
    const honest = await h.run(h.blocks.transactions(h.header, WATCHED));
    expect(honest.map((tx) => tx.id)).toEqual([h.paid]);
  });

  it('never delivers a forged output from a page: a page that differs from the bytes decides nothing', async () => {
    const h = await paymentBlock();
    const path = `/block/${h.header.hash}/txs/0`;
    const page = (await getJson(h, path)) as unknown as Json[];
    // The page pays PAYEE from the stranger's funding transaction (the bytes do not).
    const lie = page.map((tx) =>
      (tx.vout as Json[])[0]?.value === 5_000
        ? {
            ...tx,
            vout: [{ ...(tx.vout as Json[])[0], scriptpubkey: toHex(PAYEE.script) }],
          }
        : tx,
    );
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(path) ? { json: lie } : undefined,
    );
    await expect(h.run(h.blocks.transactions(h.header, WATCHED))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    // An unfiltered scan reads no page at all: the bytes alone say what the block pays.
    const all = await h.run(h.blocks.transactions(h.header));
    expect(
      all.flatMap((tx) => tx.transfers).filter((t) => t.to === PAYEE.address),
    ).toEqual([expect.objectContaining({ amount: 60_000n })]);
  });

  it('never delivers a block whose last transactions are repeated (CVE-2012-2459)', async () => {
    const h = await busyBlock(29);
    const raw = h.node.rawBlock(1);
    const txs = bitcoin.Block.fromBuffer(raw).transactions!;
    // 31 transactions: the last one twice gives the same merkle root, so the same hash, and
    // the payee's payment twice.
    expect(txs.at(-1)?.getId()).toBe(h.payee);
    const twice = concatBytes(
      raw.subarray(0, 80),
      Uint8Array.of(32),
      raw.subarray(81),
      txs.at(-1)!.toBuffer(),
    );
    expect(readBlock(twice)?.hash).toBe(h.header.hash);
    serveRaw(h, twice);
    for (const filter of [undefined, WATCHED]) {
      await expect(h.run(h.blocks.transactions(h.header, filter))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
  });

  it('never delivers witnesses the coinbase does not commit to', async () => {
    const h = await paymentBlock();
    serveRaw(
      h,
      forged(
        h,
        2,
        (txs) => {
          const payment = txs.find((tx) => tx.getId() === h.paid)!;
          payment.setWitness(0, [...payment.ins[0]!.witness, new Uint8Array(500)]);
        },
        false,
      ),
    );
    await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it("binds the header read at the height to the block's bytes (parent and time)", async () => {
    const h = await paymentBlock();
    for (const lie of [
      { ...h.header, timestamp: (h.header.timestamp ?? 0) + 1 },
      { ...h.header, parentHash: 'ab'.repeat(32) },
    ]) {
      await expect(h.run(h.blocks.transactions(lie))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
  });

  it("reads senders from the previous transactions' bytes: a forged previous output decides nothing", async () => {
    const h = await paymentBlock();
    const path = `/block/${h.header.hash}/txs/0`;
    const page = (await getJson(h, path)) as unknown as Json[];
    const claim = (txid: string, prevout: Json) =>
      page.map((tx) =>
        tx.txid === txid
          ? {
              ...tx,
              vin: (tx.vin as Json[]).map((input) => ({
                ...input,
                prevout: { ...(input.prevout as Json), ...prevout },
              })),
            }
          : tx,
      );
    // The payment's sender as a stranger (its change to OWN would read as a deposit), the
    // in-block child's previous output (the payment's change) at another value, and the
    // child as a spend from PAYEE, to have it delivered to PAYEE's scan.
    for (const [lie, address] of [
      [claim(h.paid, { scriptpubkey: toHex(STRANGER.script) }), OWN.address],
      [claim(h.child, { value: 1 }), OWN.address],
      [claim(h.child, { scriptpubkey: toHex(PAYEE.script) }), PAYEE.address],
    ] as const) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(path) ? { json: lie } : undefined,
      );
      await expect(
        h.run(h.blocks.transactions(h.header, { addresses: [address] })),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    }
    h.node.clearIntercept('a');
    // The previous transaction's bytes, served for another txid, decide nothing either.
    const other = h.node.transaction(h.child)!.toHex();
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${h.parent}/hex`) ? { text: other } : undefined,
    );
    await expect(h.run(h.blocks.transactions(h.header, WATCHED))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.clearIntercept('a');
    const [payment] = await h.run(h.blocks.transactions(h.header, WATCHED));
    expect(payment?.transfers.map((t) => t.from)).toEqual([[OWN.address], [OWN.address]]);
  });

  it('reads each outside previous transaction once, and no page when nothing is filtered', async () => {
    const h = await paymentBlock();
    h.calls.length = 0;
    await h.run(h.blocks.transactions(h.header));
    expect(h.calls.map((c) => c.request.route)).toEqual([
      '/block/:hash/raw',
      // The payment's parent; the child's parent is the payment, in the block itself.
      '/tx/:txid/hex',
      '/block-height/:height',
    ]);
    expect(h.calls[1]?.request.path).toBe(`/tx/${h.parent}/hex`);
    expect(h.calls.every((c) => c.options.purpose === 'monitor')).toBe(true);
    // A scan keeps none of the previous transactions it reads (a full block's thousands
    // would evict a build's), but one the client keeps answers without a read.
    h.calls.length = 0;
    await h.run(h.ctx.esplora.previousTx(h.parent, MONITOR));
    expect(h.calls.map((c) => c.request.route)).toEqual(['/tx/:txid/hex']);
    h.calls.length = 0;
    await h.run(h.blocks.transactions(h.header));
    expect(h.calls.map((c) => c.request.route)).not.toContain('/tx/:txid/hex');
    h.calls.length = 0;
    // Filtered: one page, and the previous transactions of the delivered ones only.
    expect(
      await h.run(h.blocks.transactions(h.header, { addresses: [STRANGER.address] })),
    ).toHaveLength(1);
    expect(h.calls.map((c) => c.request.route)).toEqual([
      '/block/:hash/raw',
      '/block/:hash/txs/:start',
      '/block-height/:height',
    ]);
  });

  it('decides nothing when a previous transaction is not available', async () => {
    const h = await paymentBlock();
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${h.parent}/hex`)
        ? { status: 404, text: 'Transaction not found' }
        : undefined,
    );
    await expect(h.run(h.blocks.transactions(h.header))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('decides nothing on a reorged-away block whose bytes a light-mode endpoint still serves', async () => {
    const h = await utxoHarness();
    h.node.endpoint('a', { lightMode: true });
    h.node.mine(2);
    const blocks = blockSource(h.ctx);
    const header = (await h.run(blocks.header(2n)))!;
    h.node.reorg(1);
    h.node.mine(1);
    // bitcoind still has the old block's bytes; the block at its height is another.
    expect((await get(h, `/block/${header.hash}/raw`)).status).toBe(200);
    await expect(h.run(blocks.transactions(header))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });
});
