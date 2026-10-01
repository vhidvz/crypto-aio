import {
  addressCodec,
  addressHistory,
  chainReader,
  listUnspent,
} from '../../../src/adapters/avalanche/reader';
import { locate, SCAN_DEPTH } from '../../../src/adapters/avalanche/context';
import { cb58Encode } from '../../../src/adapters/avalanche/cb58';
import { avalancheHarness } from './support/harness';
import { FAUCET_BYTES, OTHER_BYTES, TEST_BYTES, TEST_PUBKEY } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'txid' as const, canonical: true });
const MISSING = cb58Encode(new Uint8Array(32).fill(9));

describe('the Avalanche reader', () => {
  it('derives and checks addresses', () => {
    const h = avalancheHarness();
    const codec = addressCodec(h.ctx);
    expect(codec.fromPublicKey(TEST_PUBKEY)).toEqual({
      canonical: h.from,
      display: h.from,
    });
    expect(codec.validate(h.from)).toBe(true);
    expect(codec.validate('P' + h.from.slice(1))).toBe(false);
    expect(codec.normalize(h.from.slice(2)).canonical).toBe(h.from);
  });

  it('counts only the AVAX a transfer may spend as the balance', async () => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 1_000n);
    h.node.fund(TEST_BYTES, 2_000n, { threshold: 2, owners: [TEST_BYTES, OTHER_BYTES] });
    h.node.fund(TEST_BYTES, 4_000n, { locktime: 9_999_999_999n });
    h.node.mint(TEST_BYTES, 8_000n, { assetId: cb58Encode(new Uint8Array(32).fill(5)) });
    const reader = chainReader(h.ctx);
    expect(await h.run(reader.getBalance(h.from, 'native'))).toBe(1_000n);
    await expect(
      h.run(reader.getBalance(h.from, { standard: 'erc20', contract: 'x' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const unspent = await h.run(listUnspent(h.ctx, h.from));
    expect(
      unspent.map((u) => [u.amount, u.spendable, u.threshold, u.locktime > 0n]),
    ).toEqual([
      [8_000n, false, 1, false],
      [4_000n, false, 1, true],
      [2_000n, false, 2, false],
      [1_000n, true, 1, false],
    ]);
  });

  it('reads heights, blocks by height and by id', async () => {
    const h = avalancheHarness();
    h.node.fund(OTHER_BYTES, 5n);
    const reader = chainReader(h.ctx);
    expect(await h.run(reader.getBlockHeight())).toBe(1n);
    expect(await h.run(reader.getFinalizedHeight())).toBe(1n);
    const block = await h.run(reader.getBlock(1n));
    expect(block).toMatchObject({ height: 1n, parentHash: h.config.genesisBlockId });
    expect(block?.transactionIds).toHaveLength(1);
    expect(await h.run(reader.getBlock(block?.hash ?? ''))).toEqual(block);
    expect(await h.run(reader.getBlock(9n))).toBeNull();
    expect(await h.run(reader.getBlock(-1n))).toBeNull();
    expect(await h.run(reader.getBlock('not-an-id'))).toBeNull();
    expect(await h.run(reader.getBlock(MISSING))).toBeNull();
  });

  it('reads a finalized height N − 1 blocks below the head', async () => {
    const h = avalancheHarness();
    h.node.mine();
    h.node.mine();
    const reader = chainReader({
      ...h.ctx,
      config: { ...h.ctx.config, confirmations: 2 },
    });
    expect(await h.run(reader.getFinalizedHeight())).toBe(1n);
    const deep = chainReader({ ...h.ctx, config: { ...h.ctx.config, confirmations: 9 } });
    expect(await h.run(deep.getFinalizedHeight())).toBe(0n);
  });

  it('reads a transaction with its transfers, senders and fee', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 7_000n);
    const tx = await h.run(chainReader(h.ctx).getTransaction(id));
    expect(tx).toMatchObject({
      id,
      decoding: 'complete',
      observation: { seen: 'block', blockHeight: 1n, success: true },
      fee: [{ asset: 'native', amount: 1_000_000n }],
    });
    const paid = tx?.transfers.find((t) => t.to === h.address(OTHER_BYTES));
    expect(paid).toMatchObject({
      amount: 7_000n,
      from: [h.address(FAUCET_BYTES)],
      source: 'native',
    });
    expect(paid?.locator).toMatch(/^out:\d$/);
    expect(await h.run(chainReader(h.ctx).getTransaction(MISSING))).toBeNull();
    expect(await h.run(chainReader(h.ctx).getTransaction('nope'))).toBeNull();
  });

  it('observes an X-Chain transaction: unknown, then in its block', async () => {
    const h = avalancheHarness();
    const reader = chainReader(h.ctx);
    expect(await h.run(reader.observe(ref(MISSING), undefined, undefined))).toEqual({
      seen: 'none',
    });
    expect(await h.run(reader.observe(ref('bad'), undefined, undefined))).toEqual({
      seen: 'none',
    });
    const id = h.node.fund(OTHER_BYTES, 5n, { mine: false });
    // The X-Chain shows no mempool: an issued transaction is unknown until accepted.
    expect(await h.run(reader.observe(ref(id), undefined, undefined))).toEqual({
      seen: 'none',
    });
    h.node.mine();
    expect(await h.run(reader.observe(ref(id), undefined, undefined))).toEqual({
      seen: 'block',
      txHash: id,
      blockHeight: 1n,
      blockHash: h.node.block(1)?.id,
      success: true,
    });
  });

  it('observes a P-Chain transaction through its status: mempool, committed, dropped', async () => {
    const h = avalancheHarness({ vm: 'pvm' });
    const reader = chainReader(h.ctx);
    const id = h.node.fund(OTHER_BYTES, 5n, { mine: false });
    expect(await h.run(reader.observe(ref(id), undefined, undefined))).toEqual({
      seen: 'mempool',
      txHash: id,
    });
    h.node.mine();
    expect(await h.run(reader.observe(ref(id), undefined, undefined))).toMatchObject({
      seen: 'block',
      blockHeight: 1n,
      success: true,
    });
    const dropped = h.node.fund(OTHER_BYTES, 6n, { mine: false });
    h.node.drop(dropped);
    expect(await h.run(reader.observe(ref(dropped), undefined, undefined))).toEqual({
      seen: 'none',
    });
  });

  it('reads an aborted P-Chain proposal as failed in its block', async () => {
    const h = avalancheHarness({ vm: 'pvm' });
    h.node.mine({ proposal: 'abort' });
    const id = h.node.block(1)?.txIds[0] as string;
    const seen = await h.run(chainReader(h.ctx).observe(ref(id), undefined, undefined));
    expect(seen).toMatchObject({
      seen: 'block',
      success: false,
      reason: 'the transaction was aborted',
    });
  });
});

describe('locating a transaction', () => {
  it('asks the Data API, then checks its block on the node, and keeps it', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    const located = await h.run(locate(h.ctx, id, { purpose: 'monitor' }));
    expect(located).toEqual({ height: 1n, hash: h.node.block(1)?.id });
    const indexed = h.indexerCalls.length;
    expect(await h.run(locate(h.ctx, id, { purpose: 'monitor' }))).toEqual(located);
    expect(h.indexerCalls).toHaveLength(indexed); // cached: accepted blocks never change
  });

  it('scans the newest blocks when the indexer does not know it yet', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.node.hideFromIndexer(id);
    h.node.mine();
    expect(await h.run(locate(h.ctx, id, { purpose: 'monitor' }))).toEqual({
      height: 1n,
      hash: h.node.block(1)?.id,
    });
  });

  it(`gives up below the newest ${SCAN_DEPTH} blocks: an accepted transaction then reads as mempool`, async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.node.hideFromIndexer(id);
    for (let i = 0; i < SCAN_DEPTH; i++) h.node.mine();
    expect(await h.run(locate(h.ctx, id, { purpose: 'monitor' }))).toBeUndefined();
    expect(
      await h.run(chainReader(h.ctx).observe(ref(id), undefined, undefined)),
    ).toEqual({ seen: 'mempool', txHash: id });
  });

  it("refuses an indexer whose block is not the node's (retryable)", async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.node.fund(OTHER_BYTES, 6n);
    const lie = h.node.block(2)?.id as string;
    jest.spyOn(h.ctx.dataApi, 'locate').mockResolvedValue({ height: 2n, hash: lie });
    await expect(h.run(locate(h.ctx, id, { purpose: 'monitor' }))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('waits for a node that has not reached the block the indexer names', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    jest.spyOn(h.ctx.dataApi, 'locate').mockResolvedValue({ height: 9n, hash: id });
    expect(await h.run(locate(h.ctx, id, { purpose: 'monitor' }))).toBeUndefined();
  });
});

describe('a transaction from before the X-Chain had blocks', () => {
  it('reads as not seen: final, but with no block to name', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    jest.spyOn(h.ctx.dataApi, 'locate').mockResolvedValue('no-block');
    expect(
      await h.run(chainReader(h.ctx).observe(ref(id), undefined, undefined)),
    ).toEqual({
      seen: 'none',
    });
  });
});

describe('address history', () => {
  it('lists what pays or was signed by the address, newest first, page by page', async () => {
    const h = avalancheHarness();
    const first = h.node.fund(TEST_BYTES, 1_000n);
    const second = h.node.fund(TEST_BYTES, 2_000n);
    h.node.fund(OTHER_BYTES, 3_000n); // not the address's
    const history = addressHistory(h.ctx);
    const page = await h.run(history.list(h.from, { limit: 1 }));
    expect(page.items.map((t) => t.id)).toEqual([second]);
    expect(page.next).toBeDefined();
    const rest = await h.run(
      history.list(h.from, { limit: 5, cursor: page.next as string }),
    );
    expect(rest.items.map((t) => t.id)).toEqual([first]);
    expect(rest.next).toBeUndefined();
  });

  it('refuses a bad limit or cursor', async () => {
    const h = avalancheHarness();
    const history = addressHistory(h.ctx);
    await expect(h.run(history.list(h.from, { limit: 0 }))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    await expect(
      h.run(history.list(h.from, { limit: 1, cursor: 'a b' })),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('drops an entry the server lists for another address', async () => {
    const h = avalancheHarness();
    const other = h.node.fund(OTHER_BYTES, 3_000n);
    jest.spyOn(h.ctx.dataApi, 'history').mockResolvedValue({
      items: [
        { txId: other, location: { height: 1n, hash: h.node.block(1)?.id as string } },
      ],
    });
    expect((await h.run(addressHistory(h.ctx).list(h.from, { limit: 5 }))).items).toEqual(
      [],
    );
  });

  it('refuses an entry the node does not have (retryable)', async () => {
    const h = avalancheHarness();
    jest
      .spyOn(h.ctx.dataApi, 'history')
      .mockResolvedValue({ items: [{ txId: MISSING }] });
    await expect(
      h.run(addressHistory(h.ctx).list(h.from, { limit: 5 })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });
});
