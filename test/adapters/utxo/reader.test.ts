import { walletAddress } from '../../../src/adapters/utxo/address';
import { txidOfHex } from '../../../src/adapters/utxo/codec';
import { PROOF, READ } from '../../../src/adapters/utxo/context';
import { EsploraClient } from '../../../src/adapters/utxo/esplora';
import * as rawtx from '../../../src/adapters/utxo/rawtx';
import { toHex } from '../../../src/core/util/bytes';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import {
  addressCodec,
  addressHistory,
  chainReader,
  listUnspent,
} from '../../../src/adapters/utxo/reader';
import { utxoHarness } from './support/harness';
import {
  malleate,
  manyOutputs,
  signedLegacySpend,
  signedSpend,
  txidOfStripped,
} from './support/tx';
import { OTHER_PUBKEY, REGTEST, TEST_KEY, TEST_PUBKEY } from './support/vectors';

const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const ref = (id: string) => ({ id, idKind: 'txid' as const, canonical: true });

async function withSpend() {
  const h = await utxoHarness();
  const outpoint = h.node.fund(OWN.address, 100_000n);
  const [txid] = outpoint.split(':') as [string];
  const spent = h.node.submit(
    signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE.script, 90_000n]]),
  );
  return { ...h, reader: chainReader(h.ctx), outpoint, spent };
}

describe('the address codec', () => {
  it('validates strictly, normalizes with the type variant and derives per wallet type', async () => {
    const h = await utxoHarness();
    const codec = addressCodec(h.ctx);
    expect(codec.validate(OWN.address)).toBe(true);
    expect(codec.validate('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    expect(codec.normalize(OWN.address.toUpperCase())).toEqual({
      canonical: OWN.address,
      display: OWN.address,
      variant: { type: 'p2wpkh' },
    });
    expect(codec.fromPublicKey(TEST_PUBKEY, {}).canonical).toBe(OWN.address);
    expect(
      codec.fromPublicKey(TEST_PUBKEY, { utxo: { addressType: 'p2sh-p2wpkh' } }),
    ).toMatchObject({
      canonical: walletAddress(TEST_PUBKEY, 'p2sh-p2wpkh', REGTEST).address,
      variant: { type: 'p2sh' },
    });
    expect(() =>
      codec.fromPublicKey(TEST_PUBKEY, { utxo: { addressType: 'p2wsh' } }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    // Final review M1: an unknown option names the accepted ones, never the caller's key,
    // which may be a pasted secret.
    for (const key of ['changeAdress', `xprv${'K'.repeat(107)}`, 'apiKey=hunter2']) {
      expect(() => codec.fromPublicKey(TEST_PUBKEY, { utxo: { [key]: 'x' } })).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message:
            "wallet.utxo has an unknown option; the accepted names are 'addressType', 'allowExternalChangeAddress' and 'changeAddress'",
        }),
      );
    }
  });
});

describe('the reader', () => {
  it('tags every call as the contract table says, with identifier-free routes (R14, R41)', async () => {
    const h = await withSpend();
    h.calls.length = 0;
    await h.run(h.reader.getBalance(OWN.address, 'native'));
    await h.run(h.reader.getBlockHeight());
    await h.run(h.reader.getFinalizedHeight());
    await h.run(h.reader.observe(ref(h.spent), undefined, undefined));
    await h.run(h.reader.getTransaction(h.spent));
    expect(h.calls.map((c) => [c.transport, c.request.route, c.options.purpose])).toEqual(
      [
        ['indexer', '/address/:address', 'read'],
        ['rpc', '/blocks/tip/height', 'monitor'],
        ['rpc', '/blocks/tip/height', 'monitor'],
        ['rpc', '/tx/:txid', 'monitor'],
        ['rpc', '/tx/:txid', 'read'],
      ],
    );
    for (const call of h.calls) {
      expect(call.options).toMatchObject({ retry: 'safe' });
      expect(call.options.quorum).toBeUndefined();
      expect(call.request.route).not.toMatch(/[0-9a-f]{64}|bcrt1/);
    }
  });

  it('reads balances, blocks and decoded transactions, and refuses tokens', async () => {
    const h = await withSpend();
    h.node.mine();
    expect(await h.run(h.reader.getBalance(PAYEE.address, 'native'))).toBe(90_000n);
    expect(await h.run(h.reader.getTransaction(h.spent))).toMatchObject({
      id: h.spent,
      decoding: 'complete',
      observation: { seen: 'block', blockHeight: 2n, success: true },
      fee: [{ asset: 'native', amount: 10_000n }],
      transfers: [
        { locator: 'vout:0', from: [OWN.address], to: PAYEE.address, amount: 90_000n },
      ],
    });
    expect((await h.run(h.reader.getBlock(2n)))?.transactionIds).toHaveLength(2);
    expect(await h.run(h.reader.getBlock(99n))).toBeNull();
    expect(await h.run(h.reader.getTransaction('ab'.repeat(32)))).toBeNull();
    await expect(
      h.run(h.reader.getBalance(OWN.address, { standard: 'brc20', contract: 'x' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await h.run(h.reader.getFinalizedHeight())).toBe(0n);
  });

  it('observes mempool, block and absence (an unknown id is a 404, never "unconfirmed")', async () => {
    const h = await withSpend();
    expect(await h.run(h.reader.observe(ref(h.spent), undefined, undefined))).toEqual({
      seen: 'mempool',
      txHash: h.spent,
    });
    h.node.mine();
    expect(
      await h.run(h.reader.observe(ref(h.spent), undefined, undefined)),
    ).toMatchObject({
      seen: 'block',
      success: true,
    });
    expect(
      await h.run(h.reader.observe(ref('cd'.repeat(32)), undefined, undefined)),
    ).toEqual({
      seen: 'none',
    });
  });

  it('turns a malformed answer into a retryable PROVIDER_UNAVAILABLE (lesson 6)', async () => {
    const h = await utxoHarness();
    h.node.intercept('a', (request) =>
      request.url.pathname.includes('/tx/') ? { json: { txid: 'nope' } } : undefined,
    );
    await expect(
      h.run(chainReader(h.ctx).getTransaction('ab'.repeat(32))),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });
});

describe('history and unspent outputs (indexer)', () => {
  it('lists confirmed history newest first with a txid cursor', async () => {
    const h = await utxoHarness();
    for (let i = 0; i < 30; i++) h.node.fund(OWN.address, 1_000n + BigInt(i));
    const history = addressHistory(h.ctx);
    const first = await h.run(history.list(OWN.address, { limit: 27 }));
    expect(first.items).toHaveLength(27);
    expect(first.items[0]?.transfers[0]?.amount).toBe(1_029n);
    const rest = await h.run(
      history.list(OWN.address, { cursor: first.next, limit: 27 }),
    );
    expect(rest.items.map((t) => t.transfers[0]?.amount)).toEqual([
      1_002n,
      1_001n,
      1_000n,
    ]);
    expect(rest.next).toBeUndefined();
    expect(h.calls.every((c) => c.transport === 'indexer')).toBe(true);
  });

  it('lists unspent outputs, confirmed first', async () => {
    const h = await utxoHarness();
    h.node.fund(OWN.address, 7_000n);
    h.node.fund(OWN.address, 5_000n, { mempool: true });
    const unspent = await h.run(listUnspent(h.ctx, OWN.address));
    expect(unspent.map((u) => [u.value, u.confirmed, u.blockHeight])).toEqual([
      [7_000n, true, 1n],
      [5_000n, false, undefined],
    ]);
  });
});

describe('answers bound to requests (I2)', () => {
  it('refuses an answer for another transaction or block as malformed (retryable)', async () => {
    const h = await withSpend();
    h.node.mine();
    const base = 'https://esplora-a.test/api';
    const get = async (path: string) =>
      (await h.node.fetch.fetch(`${base}${path}`)).text();
    const funding = h.outpoint.split(':')[0] as string;
    const foreignTx = JSON.parse(await get(`/tx/${funding}`)) as unknown;
    const genesis = h.node.options.genesisHash;
    const foreignBlock = JSON.parse(
      await get(`/block/${await get('/block-height/1')}`),
    ) as unknown;
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${h.spent}`)
        ? { json: foreignTx }
        : request.url.pathname.endsWith(`/block/${genesis}`)
          ? { json: foreignBlock }
          : undefined,
    );
    await expect(h.run(h.reader.getTransaction(h.spent))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(
      h.run(h.reader.observe(ref(h.spent), undefined, undefined)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(h.run(h.reader.getBlock(genesis))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('never puts a malformed id into a URL path', async () => {
    const h = await withSpend();
    h.calls.length = 0;
    for (const id of [
      '../address/x/utxo',
      `${h.spent}/../../fee-estimates`,
      'AB'.repeat(33),
      '',
    ]) {
      expect(await h.run(h.reader.getTransaction(id))).toBeNull();
      expect(await h.run(h.reader.getBlock(id))).toBeNull();
      expect(await h.run(h.reader.observe(ref(id), undefined, undefined))).toEqual({
        seen: 'none',
      });
    }
    expect(h.calls).toHaveLength(0);
    // An upper-case id of a real transaction is the same id.
    expect((await h.run(h.reader.getTransaction(h.spent.toUpperCase())))?.id).toBe(
      h.spent,
    );
  });
});

describe('a miner-malleated copy of our p2pkh Attempt (C2)', () => {
  it('is observed under its own txid; a segwit sender never looks for one', async () => {
    const h = await utxoHarness();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const outpoint = h.node.fund(legacy.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    const ours = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, h.node.transaction(txid)!.toHex()]],
      [[PAYEE.script, 90_000n]],
    );
    const copy = malleate(ours, 'high-s');
    h.node.mine(1, { extra: [copy] });
    const reader = chainReader(h.ctx);
    const ordering = { kind: 'inputs' as const, inputs: [outpoint] };
    expect(
      await h.run(reader.observe(ref(txidOfHex(ours)), ordering, legacy.address)),
    ).toMatchObject({
      seen: 'block',
      txHash: txidOfHex(copy),
      blockHeight: 2n,
    });
    // Without an ordering (a status lookup by id) the chain's own view is returned.
    expect(
      await h.run(reader.observe(ref(txidOfHex(ours)), undefined, undefined)),
    ).toEqual({
      seen: 'none',
    });
    h.calls.length = 0;
    expect(
      await h.run(reader.observe(ref('cd'.repeat(32)), ordering, OWN.address)),
    ).toEqual({
      seen: 'none',
    });
    expect(h.calls.map((c) => c.request.route)).toEqual(['/tx/:txid']);
  });
});

const inputs = (outpoint: string) => ({ kind: 'inputs' as const, inputs: [outpoint] });
const BASE = 'https://esplora-a.test/api';
type TxJson = Record<string, unknown> & {
  vin: Record<string, unknown>[];
  vout: Record<string, unknown>[];
};

describe('an unconfirmed Attempt the index serves (F3-R8)', () => {
  it('is in a mempool only while its first input is spent by it', async () => {
    const h = await withSpend();
    h.calls.length = 0;
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'mempool', txHash: h.spent });
    expect(h.calls.map((c) => [c.transport, c.request.route, c.options.purpose])).toEqual(
      [
        ['rpc', '/tx/:txid', 'monitor'],
        ['rpc', '/tx/:txid/outspend/:vout', 'monitor'],
      ],
    );
    // In a block, nothing more is read.
    h.node.mine();
    h.calls.length = 0;
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toMatchObject({ seen: 'block', blockHeight: 2n });
    expect(h.calls).toHaveLength(1);
    // An endpoint a block behind still has it in its mempool, and its spend agrees.
    h.node.setLag('a', 1);
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'mempool', txHash: h.spent });
  });

  it('is "none" after a reorg dropped it, though full-mode electrs still serves it', async () => {
    const h = await withSpend();
    const hex = h.node.transaction(h.spent)!.toHex();
    h.node.mine();
    // The new branch: block 2 again, without it (full-mode electrs keeps the old one's txs).
    h.node.reorg(1, { drop: [h.spent] });
    h.node.mine();
    expect(h.node.inMempool(h.spent)).toBe(false);
    // A status lookup by id cannot tell: the index's own view (a residual for the guide).
    expect(await h.run(h.reader.observe(ref(h.spent), undefined, undefined))).toEqual({
      seen: 'mempool',
      txHash: h.spent,
    });
    h.calls.length = 0;
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'none' });
    // A segwit txid cannot be malleated, so no bytes are read.
    expect(h.calls.map((c) => c.request.route)).toEqual([
      '/tx/:txid',
      '/tx/:txid/outspend/:vout',
    ]);
    // The core rebroadcasts a dropped Attempt; back in the mempool, it is seen again.
    h.node.submit(hex);
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'mempool', txHash: h.spent });
  });

  it('is "none" when another transaction spends its input (conflicted)', async () => {
    const h = await withSpend();
    const [funding] = h.outpoint.split(':') as [string];
    h.node.mine();
    h.node.reorg(1, { drop: [h.spent] });
    h.node.mine();
    h.node.submit(
      signedSpend(TEST_KEY, [[funding, 0, 100_000n]], [[PAYEE.script, 80_000n]]),
    );
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'none' });
    h.node.mine();
    expect(
      await h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).toEqual({ seen: 'none' });
  });

  it('is its malleated copy when the copy spends the input (p2pkh, C2)', async () => {
    const h = await utxoHarness();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const outpoint = h.node.fund(legacy.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    const ours = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, h.node.transaction(txid)!.toHex()]],
      [[PAYEE.script, 90_000n]],
    );
    const oursId = h.node.submit(ours);
    h.node.mine();
    h.node.reorg(1, { drop: [oursId] });
    const copy = malleate(ours, 'pushdata1');
    h.node.mine(1, { extra: [copy] });
    expect(
      await h.run(
        chainReader(h.ctx).observe(ref(oursId), inputs(outpoint), legacy.address),
      ),
    ).toMatchObject({ seen: 'block', txHash: txidOfHex(copy), blockHeight: 2n });
    // The spender's bytes must hash to the spender: others decide nothing (retryable).
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${txidOfHex(copy)}/hex`)
        ? { text: ours }
        : undefined,
    );
    await expect(
      h.run(chainReader(h.ctx).observe(ref(oursId), inputs(outpoint), legacy.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('decides nothing when the spend read is refused (lesson 18, widened)', async () => {
    const h = await withSpend();
    h.node.intercept('a', (request) =>
      request.url.pathname.includes('/outspend/')
        ? { status: 410, text: 'Gone' }
        : undefined,
    );
    await expect(
      h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('decides nothing when the transaction read is refused (lesson 18, widened; M1)', async () => {
    const h = await withSpend();
    const refusals = [
      { status: 400, text: 'Bad Request' },
      { status: 410, text: 'Gone' },
      { status: 422, text: 'Unprocessable Entity' },
      { status: 403, text: 'Forbidden' },
    ];
    for (const refusal of refusals) {
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/tx/${h.spent}`) ? refusal : undefined,
      );
      await expect(
        h.run(h.reader.observe(ref(h.spent), inputs(h.outpoint), OWN.address)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      await expect(
        h.run(h.reader.observe(ref(h.spent), undefined, undefined)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
  });

  it('decides nothing when the index contradicts itself (M2)', async () => {
    const h = await utxoHarness();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const outpoint = h.node.fund(legacy.address, 100_000n);
    const [txid] = outpoint.split(':') as [string];
    const ours = signedLegacySpend(
      TEST_KEY,
      [[txid, 0, h.node.transaction(txid)!.toHex()]],
      [[PAYEE.script, 90_000n]],
    );
    const oursId = h.node.submit(ours);
    const reader = chainReader(h.ctx);
    const notFound = (id: string) =>
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/tx/${id}`)
          ? { status: 404, text: 'Transaction not found' }
          : undefined,
      );
    // The spend names our transaction, which the transaction read does not know.
    notFound(oursId);
    await expect(
      h.run(reader.observe(ref(oursId), inputs(outpoint), legacy.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    // A malleated copy its bytes prove ours, which the transaction read does not know.
    const copy = malleate(ours, 'high-s');
    h.node.mine(1, { extra: [copy] });
    notFound(txidOfHex(copy));
    await expect(
      h.run(reader.observe(ref(oursId), inputs(outpoint), legacy.address)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    h.node.clearIntercept('a');
    expect(
      await h.run(reader.observe(ref(oursId), inputs(outpoint), legacy.address)),
    ).toMatchObject({ seen: 'block', txHash: txidOfHex(copy) });
  });

  it('reads the first input only: a conflict on another input leaves it out too (M8)', async () => {
    const h = await utxoHarness();
    const first = h.node.fund(OWN.address, 100_000n);
    const second = h.node.fund(OWN.address, 50_000n);
    const [a] = first.split(':') as [string];
    const [b] = second.split(':') as [string];
    const ours = h.node.submit(
      signedSpend(
        TEST_KEY,
        [
          [a, 0, 100_000n],
          [b, 0, 50_000n],
        ],
        [[PAYEE.script, 140_000n]],
      ),
    );
    h.node.mine();
    h.node.reorg(1, { drop: [ours] });
    h.node.mine();
    // A conflict on the second input only; the first is unspent.
    h.node.submit(signedSpend(TEST_KEY, [[b, 0, 50_000n]], [[PAYEE.script, 40_000n]]));
    const reader = chainReader(h.ctx);
    const ordering = { kind: 'inputs' as const, inputs: [first, second] };
    for (const mined of [false, true]) {
      if (mined) h.node.mine();
      h.calls.length = 0;
      expect(await h.run(reader.observe(ref(ours), ordering, OWN.address))).toEqual({
        seen: 'none',
      });
      expect(h.calls.map((c) => c.request.path)).toEqual([
        `/tx/${ours}`,
        `/tx/${a}/outspend/0`,
      ]);
    }
  });
});

describe('raw transactions bound to the id asked for', () => {
  it('refuses the bytes of another transaction, or bytes that do not decode', async () => {
    const h = await withSpend();
    const [funding] = h.outpoint.split(':') as [string];
    const fundingHex = h.node.transaction(funding)!.toHex();
    expect(await h.run(h.ctx.esplora.txHex(funding, READ))).toBe(fundingHex);
    const serve = (text: string) =>
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/tx/${funding}/hex`) ? { text } : undefined,
      );
    serve(h.node.transaction(h.spent)!.toHex());
    await expect(h.run(h.ctx.esplora.txHex(funding, READ))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    for (const junk of [
      'zz',
      `${fundingHex}00`,
      `${fundingHex}zz`,
      '00'.repeat(4_000_001),
    ]) {
      serve(junk);
      await expect(h.run(h.ctx.esplora.txHex(funding, READ))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  it('keys a quorum on the txid the bytes hash to, and decodes each answer once (F3-R9 M9)', async () => {
    const h = await utxoHarness({ endpoints: ['a', 'b'] });
    const outpoint = h.node.fund(OWN.address, 100_000n);
    const [funding] = outpoint.split(':') as [string];
    // A segwit spend: one endpoint serves it without its witness (the same txid).
    const spent = h.node.submit(
      signedSpend(TEST_KEY, [[funding, 0, 100_000n]], [[PAYEE.script, 90_000n]]),
    );
    const full = h.node.transaction(spent)!;
    const bare = full.clone();
    bare.ins.forEach((_, index) => bare.setWitness(index, []));
    // Both answers are served as they are, so only the client decodes.
    const serve = (name: string, text: string) =>
      h.node.intercept(name, (request) =>
        request.url.pathname.endsWith(`/tx/${spent}/hex`) ? { text } : undefined,
      );
    serve('a', full.toHex());
    // Decodes are counted at the linear reader (F3-R24 F2); bitcoinjs never decodes answers.
    const reads = jest.spyOn(rawtx, 'readTxHex');
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    try {
      for (const [text, decodes] of [
        [`${full.toHex()}\n`, 1], // a trailing newline: the same answer once trimmed
        [bare.toHex(), 2], // other bytes, the same txid: both decoded, once each
      ] as const) {
        serve('b', text);
        reads.mockClear();
        const hex = await h.run(h.ctx.esplora.txHex(spent, PROOF));
        expect(reads).toHaveBeenCalledTimes(decodes);
        expect(fromBuffer).not.toHaveBeenCalled();
        expect(txidOfHex(hex as string)).toBe(spent);
      }
      // Another transaction's bytes never agree with ours.
      serve('b', h.node.transaction(funding)!.toHex());
      await expect(h.run(h.ctx.esplora.txHex(spent, PROOF))).rejects.toMatchObject({
        retryable: true,
      });
    } finally {
      reads.mockRestore();
      fromBuffer.mockRestore();
    }
  });

  it('keeps previous transactions per txid, oldest out first, within its bounds (F3-R14)', async () => {
    const h = await utxoHarness();
    const [t0, t1, t2] = [1_000n, 2_000n, 3_000n].map(
      (value) => (h.node.fund(OWN.address, value).split(':') as [string])[0],
    ) as [string, string, string];
    const reads: string[] = [];
    h.node.intercept('a', (request) => {
      const [, , , txid, hex] = request.url.pathname.split('/');
      if (hex === 'hex') reads.push(txid as string);
      return undefined;
    });
    const readAll = async (client: EsploraClient, txids: readonly string[]) => {
      reads.length = 0;
      for (const txid of txids) {
        const prev = await h.run(client.previousTx(txid, READ));
        expect(prev?.txid).toBe(txid);
      }
      return [...reads];
    };
    // By count: two kept; a hit refreshes an entry.
    const two = new EsploraClient(h.transport, h.indexer, {
      entries: 2,
      bytes: 1_000_000,
    });
    expect(await readAll(two, [t0, t1, t2, t2, t1, t0, t1])).toEqual([t0, t1, t2, t0]);
    // By bytes: room for one of them only.
    const size = (txid: string) =>
      (h.node.transaction(txid) as { byteLength(): number }).byteLength();
    const one = new EsploraClient(h.transport, h.indexer, {
      entries: 10,
      bytes: size(t0) + size(t1) - 1,
    });
    expect(await readAll(one, [t0, t1, t0, t1])).toEqual([t0, t1, t0, t1]);
    // One larger than the whole budget is never kept.
    const none = new EsploraClient(h.transport, h.indexer, {
      entries: 10,
      bytes: size(t0) - 1,
    });
    expect(await readAll(none, [t0, t0])).toEqual([t0, t0]);
    // A 404 is `null`, and it is not kept.
    expect(await h.run(two.previousTx('ab'.repeat(32), READ))).toBeNull();
  });

  it('reads a transaction as large as a block allows, and nothing a block cannot hold (a lenient reader)', async () => {
    // 3.99 MB, almost all witness: a block holds it (weight = 3 × stripped + total).
    const big = manyOutputs(2, 3_990_000);
    const hex = toHex(big.bytes);
    const id = txidOfStripped(big.stripped);
    // 3.99 MB without witness: weight 15.96 M, more than a block (F3-R24 F2).
    const tooBig = manyOutputs(443_000);
    const h = await utxoHarness();
    h.node.intercept('a', (request) => {
      if (request.url.pathname.endsWith(`/tx/${id}/hex`)) return { text: hex };
      if (request.url.pathname.endsWith(`/tx/${'ee'.repeat(32)}/hex`))
        return { text: toHex(tooBig.bytes) };
      return undefined;
    });
    expect(await h.run(h.ctx.esplora.txHex(id, READ))).toBe(hex);
    await expect(h.run(h.ctx.esplora.txHex('ee'.repeat(32), READ))).rejects.toMatchObject(
      { code: 'PROVIDER_UNAVAILABLE', retryable: true },
    );
  });
});

describe('strict verdict fields, lenient chain data (lesson 6; lenient readers)', () => {
  async function served() {
    const h = await withSpend();
    h.node.mine();
    const honest = JSON.parse(
      await (await h.node.fetch.fetch(`${BASE}/tx/${h.spent}`)).text(),
    ) as TxJson;
    const serve = (json: unknown) =>
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/tx/${h.spent}`) ? { json } : undefined,
      );
    return { ...h, honest, serve };
  }

  it('refuses a missing fee or an ill-typed coinbase flag, never a default', async () => {
    const h = await served();
    const noFee: Record<string, unknown> = { ...h.honest };
    delete noFee.fee;
    const flags: unknown[] = [undefined, 'false', 0];
    const variants: unknown[] = [
      noFee,
      ...flags.map((flag) => ({
        ...h.honest,
        vin: h.honest.vin.map((input) => ({ ...input, is_coinbase: flag })),
      })),
    ];
    for (const json of variants) {
      h.serve(json);
      await expect(h.run(h.reader.getTransaction(h.spent))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  it('refuses an ill-typed outpoint index, value or status, never a default (M8)', async () => {
    const h = await served();
    const status = h.honest.status as Record<string, unknown>;
    const withVin = (vary: (input: Record<string, unknown>) => unknown) => ({
      ...h.honest,
      vin: h.honest.vin.map(vary),
    });
    const variants: unknown[] = [
      ...['0', -1, 4_294_967_296, 1.5, null].map((vout) =>
        withVin((input) => ({ ...input, vout })),
      ),
      ...['90000', -1, 1.5, 2_100_000_000_000_001, null].flatMap((value) => [
        { ...h.honest, vout: h.honest.vout.map((output) => ({ ...output, value })) },
        withVin((input) => ({
          ...input,
          prevout: { ...(input.prevout as object), value },
        })),
      ]),
      ...[
        undefined,
        null,
        'confirmed',
        { confirmed: 'true' },
        { confirmed: 1 },
        { confirmed: 0 },
        { ...status, confirmed: 'yes' },
        { confirmed: true },
        { ...status, block_height: '2' },
        { ...status, block_height: undefined },
        { ...status, block_hash: 'x' },
        { ...status, block_hash: undefined },
      ].map((bad) => ({ ...h.honest, status: bad })),
    ];
    for (const json of variants) {
      h.serve(json);
      await expect(h.run(h.reader.getTransaction(h.spent))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  it('reads an output script as large as a block allows through /tx (a lenient reader)', async () => {
    const h = await served();
    h.serve({
      ...h.honest,
      vout: [
        ...h.honest.vout,
        {
          scriptpubkey: `6a${'00'.repeat(3_989_999)}`,
          scriptpubkey_asm: '',
          scriptpubkey_type: 'op_return',
          value: 0,
        },
      ],
    });
    expect(await h.run(h.reader.getTransaction(h.spent))).toMatchObject({
      decoding: 'complete',
      transfers: [{ locator: 'vout:0', to: PAYEE.address, amount: 90_000n }],
    });
  });

  it('reads any 32-bit version, printed signed or not, as one signed value (M5)', async () => {
    const h = await served();
    for (const [printed, version] of [
      [-1, -1],
      [4_294_967_295, -1],
      [-2_147_483_648, -2_147_483_648],
      [2_147_483_648, -2_147_483_648],
      [0, 0],
      [2, 2],
    ] as const) {
      h.serve({ ...h.honest, version: printed });
      expect((await h.run(h.reader.getTransaction(h.spent)))?.details).toMatchObject({
        version,
      });
    }
    for (const version of [4_294_967_296, -2_147_483_649, 1.5]) {
      h.serve({ ...h.honest, version });
      await expect(h.run(h.reader.getTransaction(h.spent))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
  });

  it('names every output by its script, whatever address the server prints (M4)', async () => {
    const h = await served();
    const named = (address: (output: Record<string, unknown>) => unknown) => ({
      ...h.honest,
      vout: h.honest.vout.map((output) => ({
        ...output,
        scriptpubkey_address: address(output),
      })),
      vin: h.honest.vin.map((input) => {
        const prevout = input.prevout as Record<string, unknown>;
        return {
          ...input,
          prevout: { ...prevout, scriptpubkey_address: address(prevout) },
        };
      }),
    });
    const variants = [
      // Left out: a deposit never decodes as `partial` for it.
      named(() => undefined),
      // Another address: a transfer is never credited to an address the output does not pay.
      named((output) =>
        output.scriptpubkey_address === OWN.address ? PAYEE.address : OWN.address,
      ),
    ];
    for (const json of variants) {
      h.serve(json);
      expect(await h.run(h.reader.getTransaction(h.spent))).toMatchObject({
        decoding: 'complete',
        transfers: [
          { locator: 'vout:0', from: [OWN.address], to: PAYEE.address, amount: 90_000n },
        ],
        details: {
          vin: [{ address: OWN.address }],
          vout: [{ n: 0, address: PAYEE.address }],
        },
      });
    }
  });

  it('reads cumulative address sums beyond 21M BTC exactly; the balance is bounded', async () => {
    const h = await withSpend();
    const stats = (funded: string, spent: string) =>
      h.node.intercept('a', (request) =>
        request.url.pathname.endsWith(`/address/${OWN.address}`)
          ? {
              text: `{"address":"${OWN.address}","chain_stats":{"funded_txo_count":9,"funded_txo_sum":${funded},"spent_txo_count":8,"spent_txo_sum":${spent},"tx_count":9},"mempool_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0}}`,
            }
          : undefined,
      );
    stats('9007199254740993', '9007199254640993');
    expect(await h.run(h.reader.getBalance(OWN.address, 'native'))).toBe(100_000n);
    stats('3000000000000000', '2999999999900000');
    expect(await h.run(h.reader.getBalance(OWN.address, 'native'))).toBe(100_000n);
    for (const [funded, spent] of [
      ['100', '101'],
      ['2100000000000001', '0'],
      ['-1', '0'],
      ['1.5', '0'],
    ] as const) {
      stats(funded, spent);
      await expect(
        h.run(h.reader.getBalance(OWN.address, 'native')),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
  });
});

describe('blocks bound to the height asked for', () => {
  it('refuses a block of another height, or txids that do not match the block', async () => {
    const h = await withSpend();
    h.node.mine();
    const one = (await h.run(h.reader.getBlock(1n)))!.hash;
    const two = (await h.run(h.reader.getBlock(2n)))!.hash;
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith('/block-height/2') ? { text: one } : undefined,
    );
    await expect(h.run(h.reader.getBlock(2n))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.intercept('a', (request, _signal, honest) =>
      request.url.pathname.endsWith(`/block/${two}/txids`)
        ? { json: (honest() as { json: string[] }).json.slice(1) }
        : undefined,
    );
    await expect(h.run(h.reader.getBlock(two))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.clearIntercept('a');
    h.calls.length = 0;
    expect(await h.run(h.reader.getBlock(-1n))).toBeNull();
    expect(await h.run(h.reader.getBlock(2n ** 64n))).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});

describe('indexer lists', () => {
  it('pages on while a page is full, whatever the provider page size', async () => {
    const h = await utxoHarness();
    for (let i = 0; i < 40; i++) h.node.fund(OWN.address, 1_000n + BigInt(i));
    // A provider that answers 30 per page.
    h.node.intercept('a', async (request, _signal, honest) => {
      if (!request.url.pathname.endsWith('/txs/chain')) return undefined;
      const first = (honest() as { json: { txid: string }[] }).json;
      const next = (await (
        await h.node.fetch.fetch(`${request.url.href}/${first[24]!.txid}`)
      ).json()) as unknown[];
      return { json: [...first, ...next.slice(0, 5)] };
    });
    const page = await h.run(addressHistory(h.ctx).list(OWN.address, { limit: 40 }));
    expect(page.items.map((t) => t.transfers[0]?.amount)).toEqual(
      Array.from({ length: 40 }, (_, i) => 1_039n - BigInt(i)),
    );
    expect(page.next).toBeUndefined();
  });

  it("never lists another address's transaction (a dropped server-side filter)", async () => {
    const h = await utxoHarness();
    h.node.fund(OWN.address, 1_000n);
    const foreign = h.node.fund(PAYEE.address, 2_000n).split(':')[0] as string;
    h.node.fund(OWN.address, 3_000n);
    const foreignTx = (await (
      await h.node.fetch.fetch(`${BASE}/tx/${foreign}`)
    ).json()) as unknown;
    h.node.intercept('a', (request, _signal, honest) => {
      if (!request.url.pathname.endsWith('/txs/chain')) return undefined;
      const [newest, ...rest] = (honest() as { json: unknown[] }).json;
      return { json: [newest, foreignTx, ...rest] };
    });
    const page = await h.run(addressHistory(h.ctx).list(OWN.address, { limit: 10 }));
    expect(page.items.map((t) => t.transfers[0]?.amount)).toEqual([3_000n, 1_000n]);
    expect(page.items.map((t) => t.id)).not.toContain(foreign);
  });

  it('lists an unspent output named twice once, and refuses two that disagree (M3)', async () => {
    const h = await utxoHarness();
    h.node.fund(OWN.address, 7_000n);
    type Utxo = Record<string, unknown>;
    const serve = (vary: (utxo: Utxo) => Utxo) =>
      h.node.intercept('a', (request, _signal, honest) => {
        if (!request.url.pathname.endsWith('/utxo')) return undefined;
        const listed = (honest() as { json: Utxo[] }).json;
        return { json: [...listed, ...listed.map(vary)] };
      });
    serve((utxo) => ({ ...utxo }));
    expect((await h.run(listUnspent(h.ctx, OWN.address))).map((u) => u.value)).toEqual([
      7_000n,
    ]);
    const disagreements: ((utxo: Utxo) => Utxo)[] = [
      (utxo) => ({ ...utxo, value: 7_001 }),
      (utxo) => ({ ...utxo, status: { confirmed: false } }),
      (utxo) => ({ ...utxo, status: { ...(utxo.status as Utxo), block_height: 2 } }),
      (utxo) => ({
        ...utxo,
        status: { ...(utxo.status as Utxo), block_hash: 'ee'.repeat(32) },
      }),
    ];
    for (const vary of disagreements) {
      serve(vary);
      await expect(h.run(listUnspent(h.ctx, OWN.address))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
  });
});

describe('the harness', () => {
  it('is deterministic: a retried read never draws on Math.random (R46)', async () => {
    // Spied before the transports exist, which capture the jitter source when built.
    const random = jest.spyOn(Math, 'random');
    try {
      const h = await withSpend();
      let failed = false;
      h.node.intercept('a', () => {
        if (failed) return undefined;
        failed = true;
        return { status: 503, text: 'Service Unavailable' };
      });
      random.mockClear();
      expect(await h.run(h.reader.getBlockHeight())).toBe(1n);
      expect(failed).toBe(true);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
