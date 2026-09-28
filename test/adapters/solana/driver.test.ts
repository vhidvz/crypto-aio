import { base58 } from '@scure/base';
import { Connection, VersionedMessage } from '@solana/web3.js';
import { SOLANA_CHAIN } from '../../../src/adapters/solana/chains';
import {
  systemTransfer,
  transferChecked,
  createAssociatedTokenAccountIdempotent,
} from '../../../src/adapters/solana/programs';
import type { SolanaExpiryOrdering } from '../../../src/adapters/solana/types';
import { web3DriverFactory } from '../../../src/adapters/solana/web3';
import type { BuildContext, ChainDriver } from '../../../src/core/driver/types';
import { noopLogger } from '../../../src/core/events/logger';
import type { NetworkInfo } from '../../../src/core/model/chain';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { OrderingData } from '../../../src/core/model/ordering';
import type { Transport } from '../../../src/core/transport/types';
import { nodeTransport, recording, type Endpoint } from './support/harness';
import { associatedAddress } from './support/node';
import { signedTx } from './support/tx';
import { KEY_ADDRESS, KEY_PUBLIC, MINT, RECIPIENT, sign } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'signature' as const, canonical: true });

/** The parts of a `jsonParsed` transaction the reformatting tests change. */
interface TokenBalanceJson {
  owner?: string;
  uiTokenAmount: { amount: string; uiAmount: number | null };
}
interface TransactionJson {
  blockTime?: number | null;
  meta: Record<string, unknown> & {
    preTokenBalances: TokenBalanceJson[];
    postTokenBalances: TokenBalanceJson[];
  };
  transaction: { message: { instructions: Record<string, unknown>[] } };
}

async function driverFor(
  endpoints: readonly Endpoint[] = ['a', 'b'],
  indexer?: Transport,
) {
  const t = nodeTransport({}, endpoints);
  const { transport, calls } = recording(t.transport);
  const driver: ChainDriver = await web3DriverFactory.create({
    chain: SOLANA_CHAIN,
    network: SOLANA_CHAIN.networks.devnet as NetworkInfo,
    library: '@solana/web3.js',
    transport,
    ...(indexer ? { indexer } : {}),
    clock: t.clock,
    log: noopLogger,
    options: {},
  });
  t.node.fund(KEY_ADDRESS, 10_000_000_000n);
  return { ...t, driver, calls };
}

type Harness = Awaited<ReturnType<typeof driverFor>>;

const SOL = 1_000_000_000n;

/**
 * The expiry ordering of a transaction signed against `block`'s hash, as the builder records
 * it from `getLatestBlockhash` (F5-R9): the last valid height, the blockhash and its slot.
 */
const expiryAt = (block: {
  readonly hash: string;
  readonly slot: bigint;
  readonly height: bigint;
}): SolanaExpiryOrdering => ({
  kind: 'expiry',
  lastValidHeight: block.height + 150n,
  blockhash: block.hash,
  blockhashSlot: block.slot,
});

/** A System transfer signed at the head but not sent: its bytes and expiry ordering. */
function heldBack(h: Harness, lamports = SOL) {
  const raw = signedTx(h.node.head.hash, [
    systemTransfer(KEY_ADDRESS, RECIPIENT, lamports),
  ]);
  const ordering = expiryAt(h.node.head);
  return { raw, last: ordering.lastValidHeight, ordering };
}

/** Produces blocks until the node's head is at `height`. */
function produceTo(h: Harness, height: bigint): void {
  while (h.node.head.height < height) h.node.produce();
}

/** Runs `includedFinal` `times` times; every answer or retryable error it gave. */
async function verdicts(h: Harness, id: string, ordering: OrderingData, times = 6) {
  const out: unknown[] = [];
  for (let i = 0; i < times; i++) {
    try {
      out.push(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      );
    } catch (error) {
      expect(error).toMatchObject({ retryable: true });
      out.push('decides nothing');
    }
  }
  return out;
}

/** A System transfer signed at the head; returns its signature and expiry ordering. */
function transfer(
  h: Harness,
  lamports = 1_000_000_000n,
): { id: string; ordering: OrderingData } {
  const id = h.node.submit(
    signedTx(h.node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, lamports)]),
  );
  return { id, ordering: expiryAt(h.node.head) };
}

describe('the Solana driver factory', () => {
  it('sets identity (getGenesisHash) and height probes before any traffic', async () => {
    const h = await driverFor();
    expect(h.node.served).toEqual([]);
    h.node.intercept = (endpoint, method) =>
      endpoint === 'a' && method === 'getGenesisHash'
        ? { result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }
        : undefined;
    h.node.produce(3);
    await h.run(h.transport.refreshHealth());
    expect(h.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'disabled'],
      ['b', 'healthy'],
    ]);
    expect(h.transport.highestHeight()).toBe(3n);
    expect(h.seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.misconfigured',
        expected: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        actual: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      }),
    );
  });

  it('calls setProbes exactly once on the transport and the indexer, before any traffic', async () => {
    const counted = (target: Transport, counts: string[]) =>
      new Proxy(target, {
        get(t, prop) {
          const value = Reflect.get(t, prop) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            counts.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const main = nodeTransport({}, ['main']);
    const idx = nodeTransport({}, ['idx']);
    const counts: string[] = [];
    const indexerCounts: string[] = [];
    await web3DriverFactory.create({
      chain: SOLANA_CHAIN,
      network: SOLANA_CHAIN.networks.devnet as NetworkInfo,
      library: '@solana/web3.js',
      transport: counted(main.transport, counts),
      indexer: counted(idx.transport, indexerCounts),
      clock: main.clock,
      log: noopLogger,
      options: {},
    });
    expect(counts).toEqual(['setProbes']);
    expect(indexerCounts).toEqual(['setProbes']);
    expect([main.node.served, idx.node.served]).toEqual([[], []]);
  });

  it('offers expiry ordering, one output, ext.solana and a fresh native client per call', async () => {
    const h = await driverFor(['main']);
    expect(h.driver.ordering).toBe('expiry');
    expect([...h.driver.capabilities].sort()).toEqual([
      'address-history',
      'block-scan',
      'expiry',
      'memo',
      'tokens',
    ]);
    expect([h.driver.replacement, h.driver.sequence]).toEqual([undefined, undefined]);
    expect(h.driver.limits?.({})).toEqual({ maxOutputs: 1 });
    expect(h.driver.address.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    h.node.createMint(MINT, 6);
    h.node.mintTo(MINT, KEY_ADDRESS, 7n);
    const accounts = await h.run(
      (h.driver.ext!.solana!.getTokenAccounts! as (o: string) => Promise<unknown>)(
        KEY_ADDRESS,
      ),
    );
    expect(accounts).toEqual([expect.objectContaining({ mint: MINT, amount: 7n })]);
    const first = h.driver.createNativeClient!();
    const second = h.driver.createNativeClient!();
    expect(first.client).toBeInstanceOf(Connection);
    expect(first.client).not.toBe(second.client);
    // The native Connection reaches the same transport through its bridged fetch.
    h.node.served.length = 0;
    expect(await h.run((first.client as Connection).getBlockHeight('confirmed'))).toBe(
      Number(h.node.head.height),
    );
    expect(h.node.served.map((s) => s.method)).toEqual(['getBlockHeight']);
    await first.close?.();
    await second.close?.();
  });

  it('puts probes on the indexer too, and reads history from it', async () => {
    const indexer = nodeTransport({}, ['idx']);
    const h = await driverFor(['main'], indexer.transport);
    expect(indexer.transport.hasProbes()).toBe(true);
    indexer.node.fund(KEY_ADDRESS, 10_000_000_000n);
    indexer.node.produce(1);
    indexer.node.submit(
      signedTx(indexer.node.head.hash, [
        systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
      ]),
    );
    indexer.node.produce(1);
    const page = await indexer.run(h.driver.history!.list(KEY_ADDRESS, { limit: 5 }));
    expect(page.items).toHaveLength(1);
    expect(h.node.served.filter((s) => s.method === 'getSignaturesForAddress')).toEqual(
      [],
    );
  });

  it('never waits on a real timer on its request paths (lesson 1)', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    try {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.produce(3);
      await h.run(h.driver.reader.observe(ref(id), ordering, KEY_ADDRESS));
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS));
      await h.run(h.driver.reader.getTransaction(id));
      await h.run(
        h.driver.blocks!.transactions((await h.run(h.driver.blocks!.header(3n)))!),
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Solana proofs', () => {
  it('proves inclusion only once final, from both endpoints, on proof tags', async () => {
    const h = await driverFor();
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.produce(1);
    await expect(
      h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.produce(2);
    h.calls.length = 0;
    h.node.served.length = 0;
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: true,
      blockHeight: 3n,
      blockHash: h.node.block(3n)?.hash,
      txHash: id,
    });
    expect(
      h.calls.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
    expect(new Set(h.node.served.map((s) => s.endpoint))).toEqual(new Set(['a', 'b']));
    expect(
      await h.run(h.driver.proofs.slotConsumed(ordering, KEY_ADDRESS, 'finalized')),
    ).toBe(false);
  });

  it('never reads another transaction as the one asked for (lookups by id)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const ours = transfer(h);
    // Another transfer, failed on chain: read as ours it would prove a failure.
    const other = h.node.submit(
      signedTx(h.node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 20n * SOL)]),
      { skipPreflight: true },
    );
    h.node.produce(3);
    h.node.intercept = (endpoint, method, params) =>
      method === 'getTransaction' && params[0] === ours.id
        ? { result: h.node.answer(endpoint, method, [other, params[1]]) }
        : undefined;
    expect(await verdicts(h, ours.id, ours.ordering)).toEqual(
      Array(6).fill('decides nothing'),
    );
    h.node.intercept = undefined;
    expect(
      await h.run(
        h.driver.proofs.includedFinal(ref(ours.id), ours.ordering, KEY_ADDRESS),
      ),
    ).toMatchObject({ included: true, success: true, txHash: ours.id });
  });

  it('agrees across formatting differences and decides nothing on a different fact (Review Focus 2)', async () => {
    const h = await driverFor();
    h.node.createMint(MINT, 6);
    h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    h.node.produce(2);
    const destination = associatedAddress(RECIPIENT, MINT);
    const id = h.node.submit(
      signedTx(h.node.head.hash, [
        createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
        transferChecked(
          associatedAddress(KEY_ADDRESS, MINT),
          MINT,
          destination,
          KEY_ADDRESS,
          2_000_000n,
          6,
        ),
      ]),
    );
    const ordering: OrderingData = {
      kind: 'expiry',
      lastValidHeight: h.node.head.height + 150n,
    };
    h.node.produce(3);
    /** Endpoint b formats (or alters) its finalized transaction answer. */
    const reformat = (mutate: (tx: TransactionJson) => void) => {
      h.node.intercept = (endpoint, method, params) => {
        if (endpoint !== 'b' || method !== 'getTransaction') return undefined;
        const tx = h.node.answer('b', method, params) as TransactionJson | null;
        if (tx) mutate(tx);
        return { result: tx };
      };
    };
    reformat((tx) => {
      tx.meta.costUnits = 1;
      tx.meta.logMessages = ['Program log: other node'];
      delete tx.meta.computeUnitsConsumed;
      for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
        delete b.owner;
        b.uiTokenAmount.uiAmount = null;
      }
      for (const ix of tx.transaction.message.instructions) ix.stackHeight = null;
      tx.blockTime = null;
    });
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({
      included: true,
      success: true,
    });
    reformat((tx) => {
      tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = '1';
    });
    await expect(
      h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('answers "not included" only past the window with the window on record (Review Focus 1)', async () => {
    const pruned = await driverFor(['a', { name: 'b', firstAvailableHeight: 5 }]);
    const honest = await driverFor(['a', 'b']);
    for (const h of [pruned, honest]) {
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.drop(id);
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(false);
      h.node.produce(153);
      const expired = h.run(h.driver.proofs.expired(ordering));
      const verdict = () =>
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS));
      if (h === pruned) {
        // Endpoint b pruned heights below 5: it cannot vouch for the blockhash's block
        // (height 2, F5-R9) nor the window's start (height 3). One endpoint answering while
        // the other refuses is a disagreement under the proof quorum (P25-R10).
        await expect(expired).rejects.toMatchObject({
          code: 'PROVIDER_INCONSISTENT',
          retryable: true,
        });
        await expect(verdict()).rejects.toMatchObject({
          code: 'PROVIDER_INCONSISTENT',
          retryable: true,
        });
      } else {
        expect(await expired).toBe(true);
        expect(await verdict()).toEqual({ included: false });
      }
    }
  });

  it('proves a transfer included at lastValidBlockHeight + 1 as included, never absent (I1)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const { raw, last, ordering } = heldBack(h);
    produceTo(h, last);
    const id = h.node.submit(raw, { skipPreflight: true });
    h.node.produce(3);
    expect(h.node.landed(id)?.block.height).toBe(last + 1n);
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({ included: true, success: true, blockHeight: last + 1n });
  });

  it('attests expiry with a predicate at its own height: a lagging peer decides nothing (lesson 17)', async () => {
    const h = await driverFor(['a', { name: 'b', lag: 3 }]);
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.drop(id);
    // a has finalized past lastValidHeight; b, three blocks behind, has not.
    h.node.produce(150 + 2 + 1);
    await expect(h.run(h.driver.proofs.expired(ordering))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.produce(3);
    h.calls.length = 0;
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    // No endpoint proposed a height: one quorum read of the finalized height, and one of the
    // blockhash's block at the slot the build recorded (F5-R9), nothing else.
    const anchored = ordering as SolanaExpiryOrdering;
    expect(
      h.calls.map((c) => [c.method, c.tags.purpose, c.tags.quorum, c.params]),
    ).toEqual([
      ['getBlockHeight', 'proof', 'proof', [{ commitment: 'finalized' }]],
      [
        'getBlock',
        'proof',
        'proof',
        [
          Number(anchored.blockhashSlot),
          { commitment: 'finalized', transactionDetails: 'none', rewards: false },
        ],
      ],
    ]);
    // The attested blockhash is immutable chain data: later reads only ask the height.
    h.calls.length = 0;
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    expect(h.calls.map((c) => c.method)).toEqual(['getBlockHeight']);
  });

  describe('"not included" behind one URL (C1: one endpoint, quorum 1)', () => {
    it('never answers "not included" for a landed transfer when a backend lags', async () => {
      // Two of three backends lag (the rotation then reaches a lagging one for both index
      // reads of one proof, as the old composition needed to be fooled).
      const h = await driverFor([
        { name: 'lb', backends: [{}, { lag: 20 }, { lag: 20 }] },
      ]);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      produceTo(h, last - 3n);
      // agave's preflight window is 6 blocks short of landing (Task 4, M2).
      const id = h.node.submit(raw, { skipPreflight: true });
      h.node.produce(1);
      expect(h.node.landed(id)?.block.height).toBe(last - 2n);
      // The caught-up backend has finalized lastValid + 1; the lagging one only reaches
      // lastValid − 19, below the transaction's block, so its index shows nothing.
      produceTo(h, last + 3n);
      const answers = await verdicts(h, id, ordering);
      expect(answers).not.toContainEqual({ included: false });
      expect(answers).toContain('decides nothing');
      // Once the lagging backend has finalized the block too, the transfer is proven.
      produceTo(h, last + 30n);
      expect(await verdicts(h, id, ordering)).toContainEqual(
        expect.objectContaining({ included: true }),
      );
    });

    it('never answers "not included" when a backend\'s ledger lacks the transaction\'s block', async () => {
      // The gap covers the block that holds the transaction (filled in once it lands).
      const single: bigint[] = [];
      const balanced: bigint[] = [];
      for (const endpoint of [
        { name: 'gapped', missingHeights: single },
        // Behind a balancer the block lists can come from the whole backend, so only the
        // window scan sees the gap; one gapped URL is also caught by the height index (I3).
        {
          name: 'lb',
          backends: [{}, { missingHeights: balanced }, { missingHeights: balanced }],
        },
      ]) {
        const h = await driverFor([endpoint]);
        h.node.produce(2);
        const { raw, last, ordering } = heldBack(h);
        // Mid-window, away from the window's first and last blocks.
        produceTo(h, last - 50n);
        const id = h.node.submit(raw);
        h.node.produce(1);
        const height = h.node.landed(id)?.block.height as bigint;
        expect(height).toBe(last - 49n);
        single.push(height);
        balanced.push(height);
        produceTo(h, last + 5n);
        const answers = await verdicts(h, id, ordering);
        expect(answers).not.toContainEqual({ included: false });
        expect(answers).toContain('decides nothing');
      }
    });

    it('never answers "not included" when the index hides a transaction the window holds', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      produceTo(h, last - 50n);
      const id = h.node.submit(raw);
      h.node.produce(1);
      produceTo(h, last + 3n);
      // Every block is served; only the index answers "no such transaction".
      h.node.intercept = (_endpoint, method) =>
        method === 'getTransaction' ? { result: null } : undefined;
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    });

    it('still proves an honest window without the transaction, once, and remembers it', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      const id = h.node.submit(raw);
      h.node.drop(id);
      produceTo(h, last + 1n);
      // The window's last block (lastValid + 1) is not final yet: nothing is decided.
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      produceTo(h, last + 3n);
      h.calls.length = 0;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toEqual({ included: false });
      // One block read per height of the window (151), each with its signatures.
      const scanned = h.calls.filter(
        (c) =>
          c.method === 'getBlock' &&
          (c.params as [number, { transactionDetails?: string }])[1]
            .transactionDetails === 'signatures',
      );
      expect(scanned).toHaveLength(151);
      expect(
        scanned.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
      ).toBe(true);
      h.calls.length = 0;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toEqual({ included: false });
      expect(h.calls.map((c) => c.method)).toEqual(['getTransaction']);
    });
  });

  it("reads the window as one chain of blocks from the blockhash's own (C1, F5-R9)", async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.drop(id);
    produceTo(h, 160n);
    const edits: readonly [
      string,
      bigint,
      (block: Record<string, unknown>) => void,
      string,
    ][] = [
      [
        "a first block that does not follow the blockhash's block",
        3n,
        (block) => (block.previousBlockhash = h.node.block(1n)?.hash),
        'PROVIDER_INCONSISTENT',
      ],
      [
        'a block that does not follow the one before it',
        50n,
        (block) => (block.previousBlockhash = h.node.block(10n)?.hash),
        'PROVIDER_INCONSISTENT',
      ],
      [
        'a block at another height',
        50n,
        (block) => (block.blockHeight = 51),
        'PROVIDER_INCONSISTENT',
      ],
      [
        'a block without its signatures',
        50n,
        (block) => delete block.signatures,
        'PROVIDER_UNAVAILABLE',
      ],
    ];
    for (const [, height, edit, code] of edits) {
      h.node.intercept = (endpoint, method, params) => {
        if (
          method !== 'getBlock' ||
          params[0] !== Number(h.node.block(height)?.slot) ||
          (params[1] as { transactionDetails?: string }).transactionDetails !==
            'signatures'
        ) {
          return undefined;
        }
        const block = h.node.answer(endpoint, method, params) as Record<string, unknown>;
        edit(block);
        return { result: block };
      };
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code, retryable: true });
    }
    h.node.intercept = undefined;
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toEqual({ included: false });
  });

  it('never answers "not included" from a window list that stops short (C1)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const { raw, last, ordering } = heldBack(h);
    produceTo(h, last);
    // Lands in the window's last block; the index hides it and the list stops before it.
    const id = h.node.submit(raw, { skipPreflight: true });
    h.node.produce(1);
    expect(h.node.landed(id)?.block.height).toBe(last + 1n);
    produceTo(h, last + 3n);
    const windowList = (method: string, params: readonly unknown[]) =>
      method === 'getBlocks' &&
      (params[2] as { minContextSlot?: number }).minContextSlot !== undefined;
    for (const keep of [(list: unknown[]) => list.slice(0, -1), () => []]) {
      h.node.intercept = (endpoint, method, params) => {
        if (method === 'getTransaction') return { result: null };
        if (!windowList(method, params)) return undefined;
        return { result: keep(h.node.answer(endpoint, method, params) as unknown[]) };
      };
      expect(await verdicts(h, id, ordering, 2)).toEqual(
        Array(2).fill('decides nothing'),
      );
    }
    h.node.intercept = undefined;
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({ included: true, blockHeight: last + 1n });
  });

  describe('no RPC error is a verdict (lesson 18, widened)', () => {
    it('decides nothing when long-term storage fails below the local ledger', async () => {
      // agave 4.3.0: getBlocks from below the local ledger answers -32602 "BigTable query
      // failed", getBlock answers null, and the transaction is not found.
      const h = await driverFor([{ name: 'bt', bigtableFailsBelow: 200n }]);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.drop(id);
      produceTo(h, 260n);
      // The blockhash's block (height 2) is below the local ledger too: long-term storage
      // answers null for it, so neither expiry nor absence is attested (F5-R9).
      await expect(h.run(h.driver.proofs.expired(ordering))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      const answers = await verdicts(h, id, ordering);
      expect(answers).toEqual(Array(6).fill('decides nothing'));
      const anchored = ordering as SolanaExpiryOrdering;
      expect(h.node.served).toContainEqual(
        expect.objectContaining({
          method: 'getBlock',
          params: [Number(anchored.blockhashSlot), expect.anything()],
        }),
      );
    });

    it('decides nothing when the block of a landed transfer fails to load', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.produce(5);
      h.node.intercept = (_endpoint, method) =>
        method === 'getBlock'
          ? { error: { code: -32603, message: 'Internal error' } }
          : undefined;
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      h.node.intercept = undefined;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toMatchObject({ included: true, success: true });
    });

    const INTERNAL = { code: -32603, message: 'Internal error' };
    const failing: readonly [
      string,
      (method: string, params: readonly unknown[]) => boolean,
      { readonly code: number; readonly message: string }?,
    ][] = [
      ['the index (getTransaction)', (method) => method === 'getTransaction'],
      [
        'the window list (getBlocks)',
        (method, params) =>
          method === 'getBlocks' &&
          (params[2] as { minContextSlot?: number }).minContextSlot !== undefined,
      ],
      [
        'the window list, when long-term storage fails (getBlocks)',
        (method, params) =>
          method === 'getBlocks' &&
          (params[2] as { minContextSlot?: number }).minContextSlot !== undefined,
        // agave 4.3.0, below its local ledger (lesson 18, widened).
        {
          code: -32602,
          message: 'BigTable query failed (maybe timeout due to too large range?)',
        },
      ],
      [
        'a block of the window (getBlock)',
        (method, params) =>
          method === 'getBlock' &&
          (params[1] as { transactionDetails?: string }).transactionDetails ===
            'signatures',
      ],
      [
        'the height index (getBlocks)',
        (method, params) =>
          method === 'getBlocks' &&
          (params[2] as { minContextSlot?: number }).minContextSlot === undefined,
      ],
      ['a block header (getBlock)', (method) => method === 'getBlock'],
      [
        "the blockhash's block (getBlock at the recorded slot, F5-R9)",
        (method, params) =>
          method === 'getBlock' &&
          (params[1] as { transactionDetails?: string }).transactionDetails === 'none' &&
          params[0] === 2,
      ],
      [
        'the finalized height (getBlockHeight)',
        // Not the health probe, which reads the confirmed height.
        (method, params) =>
          method === 'getBlockHeight' &&
          (params[0] as { commitment?: string }).commitment === 'finalized',
      ],
    ];
    it.each(failing)(
      'turns a definitive error from %s into a retryable PROVIDER_UNAVAILABLE',
      async (_what, fails, error = INTERNAL) => {
        const h = await driverFor(['main']);
        h.node.produce(2);
        const { id, ordering } = transfer(h);
        h.node.drop(id);
        produceTo(h, 160n);
        h.node.intercept = (_endpoint, method, params) =>
          fails(method, params) ? { error } : undefined;
        await expect(
          h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
        ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
        h.node.intercept = undefined;
        expect(
          await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
        ).toEqual({ included: false });
      },
    );
  });

  it('serves block hashes by level, null above the head or the finalized block (R33)', async () => {
    const h = await driverFor();
    h.node.skip(2);
    h.node.produce(5);
    expect(await h.run(h.driver.proofs.blockHash(3n, 'finalized'))).toBe(
      h.node.block(3n)?.hash,
    );
    expect(await h.run(h.driver.proofs.blockHash(4n, 'finalized'))).toBeNull();
    expect(await h.run(h.driver.proofs.blockHash(5n, 'latest'))).toBe(
      h.node.block(5n)?.hash,
    );
    expect(await h.run(h.driver.proofs.blockHash(6n, 'latest'))).toBeNull();
    // The unanchored head: one endpoint's finalized height (3) trailed by the peer skew (2).
    expect(await h.run(h.driver.proofs.finalizedHead())).toEqual({
      height: 1n,
      hash: h.node.block(1n)?.hash,
      timestamp: expect.any(Number),
    });
    h.node.intercept = (endpoint, method) =>
      endpoint === 'b' && method === 'getBlock'
        ? {
            result: {
              blockhash: 'Other111111111111111111111111111111111111111',
              previousBlockhash: 'p',
              parentSlot: 1,
              blockHeight: 5,
            },
          }
        : undefined;
    await expect(h.run(h.driver.proofs.blockHash(5n, 'latest'))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });
});

describe('the Solana block source', () => {
  it('scans dense heights over skipped slots, filtered by address, without votes', async () => {
    const h = await driverFor(['main']);
    h.node.produce(1);
    h.node.skip(3);
    const { id } = transfer(h);
    h.node.produce(1);
    const header = await h.run(h.driver.blocks!.header(2n));
    expect(header).toEqual({
      height: 2n,
      hash: h.node.block(2n)?.hash,
      parentHash: h.node.block(1n)?.hash,
      timestamp: expect.any(Number),
    });
    expect(h.node.block(2n)?.slot).toBe(5n);
    expect(await h.run(h.driver.blocks!.header(3n))).toBeNull();
    const vote = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000],
        postBalances: [5_000],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        signatures: ['Vote'],
        message: {
          accountKeys: [{ pubkey: 'V' }],
          instructions: [
            {
              programId: 'Vote111111111111111111111111111111111111111',
              accounts: [],
              data: '1',
            },
          ],
        },
      },
    };
    h.node.intercept = (endpoint, method, params) => {
      if (
        method !== 'getBlock' ||
        (params[1] as { transactionDetails?: string }).transactionDetails !== 'full'
      )
        return undefined;
      const block = h.node.answer(endpoint, method, params) as {
        transactions: unknown[];
      };
      block.transactions.push(vote);
      return { result: block };
    };
    expect(
      (await h.run(h.driver.blocks!.transactions(header!))).map((tx) => tx.id),
    ).toEqual([id]);
    expect(
      (
        await h.run(h.driver.blocks!.transactions(header!, { addresses: [RECIPIENT] }))
      ).map((tx) => tx.id),
    ).toEqual([id]);
    expect(
      await h.run(h.driver.blocks!.transactions(header!, { addresses: [MINT] })),
    ).toEqual([]);
    h.node.intercept = undefined;
    h.node.reorg(1);
    h.node.produce(1);
    await expect(h.run(h.driver.blocks!.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('returns a transaction whose deposit it cannot attribute (I4: a superset filter)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const header = await h.run(h.driver.blocks!.header(2n));
    const credit = (to: string) => ({
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000, 0, 1],
        postBalances: [4_000, 1_000, 1],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        signatures: [`Sig${to}`],
        message: {
          accountKeys: [{ pubkey: 'Payer' }, { pubkey: to }, { pubkey: 'SomeProgram' }],
          instructions: [
            { programId: 'SomeProgram', accounts: ['Payer', to], data: '1' },
          ],
        },
      },
    });
    h.node.intercept = (endpoint, method, params) => {
      if (method !== 'getBlock') return undefined;
      if ((params[1] as { transactionDetails?: string }).transactionDetails !== 'full') {
        return undefined;
      }
      const block = h.node.answer(endpoint, method, params) as {
        transactions: unknown[];
      };
      block.transactions.push(credit(RECIPIENT), credit('Unrelated'));
      return { result: block };
    };
    const found = await h.run(
      h.driver.blocks!.transactions(header!, { addresses: [RECIPIENT] }),
    );
    expect(found.map((tx) => [tx.id, tx.decoding])).toEqual([
      [`Sig${RECIPIENT}`, 'partial'],
    ]);
  });

  it('decides nothing when a backend does not know the history cursor (M2)', async () => {
    const h = await driverFor(['main']);
    h.node.intercept = (_endpoint, method) =>
      method === 'getSignaturesForAddress'
        ? { error: { code: -32020, message: 'Transaction x not found' } }
        : undefined;
    await expect(
      h.run(h.driver.history!.list(RECIPIENT, { limit: 2, cursor: '1'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('pages address history newest first, with the chain’s own status', async () => {
    const h = await driverFor(['main']);
    h.node.produce(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(transfer(h, 1_000_000_000n + BigInt(i)).id);
      h.node.produce(1);
    }
    const first = await h.run(h.driver.history!.list(RECIPIENT, { limit: 2 }));
    expect(first.items.map((t) => t.id)).toEqual([ids[2], ids[1]]);
    expect(first.next).toBe(ids[1]);
    const second = await h.run(
      h.driver.history!.list(RECIPIENT, { limit: 2, cursor: first.next! }),
    );
    expect([second.items.map((t) => t.id), second.next]).toEqual([[ids[0]], undefined]);
    await expect(
      h.run(h.driver.history!.list(RECIPIENT, { limit: 2, cursor: 'x' })),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    // A node that answers more than asked never ends the history early.
    h.node.intercept = (endpoint, method, params) =>
      method === 'getSignaturesForAddress'
        ? {
            result: h.node.answer(endpoint, method, [
              params[0],
              { ...(params[1] as object), limit: 3 },
            ]),
          }
        : undefined;
    const longer = await h.run(h.driver.history!.list(RECIPIENT, { limit: 2 }));
    expect([longer.items.length, longer.next]).toEqual([3, ids[0]]);
  });
});

describe('the expiry height, bound to its blockhash (F5-R9)', () => {
  const build: BuildContext = {
    from: KEY_ADDRESS,
    keys: [{ scheme: 'ed25519', publicKey: KEY_PUBLIC }],
    wallet: {},
  };
  const intent: DriverIntent = {
    asset: 'native',
    outputs: [{ to: RECIPIENT, amount: SOL }],
    from: KEY_ADDRESS,
    fee: 'normal',
  };

  /** Builds and signs a transfer through the driver, without sending it. */
  async function built(h: Harness) {
    const fee = await h.run(h.driver.builder.estimateFee(intent, build));
    const unsigned = await h.run(h.driver.builder.build(intent, fee, build));
    const signed = await h.run(
      h.driver.builder.assemble(unsigned, [
        { requestId: 's0', bytes: sign(unsigned.signingRequests[0]!.payload) },
      ]),
    );
    return { ordering: unsigned.ordering, raw: signed.raw.data, id: signed.ref.id };
  }

  interface BlockhashAnswer {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number };
  }

  /** Every endpoint answers `getLatestBlockhash` altered by `lie`, and nothing else. */
  function lying(h: Harness, lie: (answer: BlockhashAnswer) => void): void {
    h.node.intercept = (endpoint, method, params) => {
      if (method !== 'getLatestBlockhash') return undefined;
      const answer = h.node.answer(endpoint, method, params) as BlockhashAnswer;
      lie(answer);
      return { result: answer };
    };
  }

  it('records the blockhash and its slot with the height, from one answer', async () => {
    const h = await driverFor();
    h.node.produce(3);
    h.node.skip(2);
    h.node.produce(2);
    const head = h.node.head;
    const { ordering, raw } = await built(h);
    expect(ordering).toEqual(expiryAt(head));
    expect(head.slot).toBe(7n);
    // The ordering names the message's own recent blockhash.
    const message = VersionedMessage.deserialize(
      Buffer.from(raw, 'base64').subarray(1 + 64),
    );
    expect(message.recentBlockhash).toBe(head.hash);
  });

  const lies: readonly [
    string,
    (answer: BlockhashAnswer, h: Harness, skipped: bigint) => void,
    string,
  ][] = [
    [
      'a lower last valid height',
      (answer) => {
        answer.value.lastValidBlockHeight -= 100;
      },
      'PROVIDER_INCONSISTENT',
    ],
    [
      'a lower height, with the slot of the block 150 below it',
      (answer, h) => {
        answer.value.lastValidBlockHeight -= 100;
        const below = h.node.block(BigInt(answer.value.lastValidBlockHeight) - 150n);
        answer.context.slot = Number(below?.slot);
      },
      'PROVIDER_INCONSISTENT',
    ],
    [
      'a lower height, with a skipped slot',
      (answer, _h, skipped) => {
        answer.value.lastValidBlockHeight -= 100;
        answer.context.slot = Number(skipped);
      },
      'PROVIDER_UNAVAILABLE',
    ],
  ];
  it.each(lies)(
    'never proves expiry from %s while the transfer can still land',
    async (_what, lie, code) => {
      const h = await driverFor();
      h.node.produce(100);
      const skipped = h.node.head.slot + 1n;
      h.node.skip(1);
      h.node.produce(5);
      const real = h.node.head.height + 150n;
      lying(h, (answer) => lie(answer, h, skipped));
      const { ordering, raw } = await built(h);
      h.node.intercept = undefined;
      const lowered = real - 100n;
      expect(ordering).toMatchObject({ lastValidHeight: lowered });
      // Every endpoint has finalized past the lowered height; the blockhash is still valid.
      produceTo(h, lowered + 3n);
      await expect(h.run(h.driver.proofs.expired(ordering))).rejects.toMatchObject({
        code,
        retryable: true,
      });
      const id = base58.encode(Buffer.from(raw, 'base64').subarray(1, 65));
      expect(await verdicts(h, id, ordering)).toEqual(Array(6).fill('decides nothing'));
      // Never scanned a window it cannot place.
      expect(h.node.served.map((s) => s.method)).not.toContain('getBlocks');
      // The transfer still lands, and is proven included.
      expect(h.node.submit(raw)).toBe(id);
      h.node.produce(3);
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toMatchObject({ included: true, success: true });
      expect(h.node.balance(RECIPIENT)).toBe(SOL);
    },
  );

  it('still proves an honest build expired and absent', async () => {
    const h = await driverFor();
    h.node.produce(2);
    const { ordering, id } = await built(h);
    const last = (ordering as SolanaExpiryOrdering).lastValidHeight;
    produceTo(h, last + 2n);
    // The window's last block (lastValid + 1) is not final everywhere yet.
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(false);
    produceTo(h, last + 3n);
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toEqual({ included: false });
  });

  const unattestable: readonly [
    string,
    readonly Endpoint[],
    (ordering: SolanaExpiryOrdering, h: Harness, skipped: bigint) => unknown,
    string,
  ][] = [
    [
      'no blockhash on record',
      ['main'],
      ({ kind, lastValidHeight }) => ({ kind, lastValidHeight }),
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a blockhash that is not one',
      ['main'],
      (ordering) => ({ ...ordering, blockhash: 'not-a-hash' }),
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a slot beyond the exactly readable range',
      ['main'],
      (ordering) => ({ ...ordering, blockhashSlot: 2n ** 53n }),
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a slot no block has reached yet',
      ['main'],
      (ordering) => ({ ...ordering, blockhashSlot: 10_000n }),
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a skipped slot',
      ['main'],
      (ordering, _h, skipped) => ({ ...ordering, blockhashSlot: skipped }),
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a slot the endpoint pruned',
      [{ name: 'pruned', firstAvailableHeight: 50 }],
      (ordering) => ordering,
      'PROVIDER_UNAVAILABLE',
    ],
    [
      'a peer that serves another block at the slot',
      ['a', 'b'],
      (ordering, h) => {
        h.node.intercept = (endpoint, method, params) => {
          if (
            endpoint !== 'b' ||
            method !== 'getBlock' ||
            params[0] !== Number(ordering.blockhashSlot)
          ) {
            return undefined;
          }
          const block = h.node.answer(endpoint, method, params) as Record<
            string,
            unknown
          >;
          return { result: { ...block, blockhash: h.node.block(1n)?.hash } };
        };
        return ordering;
      },
      'PROVIDER_INCONSISTENT',
    ],
  ];
  it.each(unattestable)(
    'decides nothing with %s',
    async (_what, endpoints, alter, code) => {
      const h = await driverFor(endpoints);
      h.node.produce(1);
      const skipped = h.node.head.slot + 1n;
      h.node.skip(1);
      h.node.produce(1);
      const { id, ordering } = transfer(h);
      h.node.drop(id);
      produceTo(h, 160n);
      const altered = alter(ordering as SolanaExpiryOrdering, h, skipped) as OrderingData;
      await expect(h.run(h.driver.proofs.expired(altered))).rejects.toMatchObject({
        code,
        retryable: true,
      });
      expect(await verdicts(h, id, altered)).toEqual(Array(6).fill('decides nothing'));
      expect(h.node.served.map((s) => s.method)).not.toContain('getBlocks');
    },
  );

  it('answers "not expired" before the height passes, without reading the blockhash', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.drop(id);
    const { kind, lastValidHeight } = ordering as SolanaExpiryOrdering;
    h.calls.length = 0;
    // Not expired is the safe answer: it never declares a transfer dead.
    expect(await h.run(h.driver.proofs.expired({ kind, lastValidHeight }))).toBe(false);
    expect(h.calls.map((c) => c.method)).toEqual(['getBlockHeight']);
  });
});

describe('Solana proofs of failure', () => {
  it('proves a failed transfer failed, with a fixed reason (P6-2)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    // More than the sender holds: it lands, charged its fee, and fails.
    const id = h.node.submit(
      signedTx(h.node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 20n * SOL)]),
      { skipPreflight: true },
    );
    const ordering = expiryAt(h.node.head);
    h.node.produce(3);
    expect(h.node.landed(id)?.err).not.toBeNull();
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: false,
      reason: 'transaction failed',
      blockHeight: 3n,
      blockHash: h.node.block(3n)?.hash,
      txHash: id,
    });
    expect(
      await h.run(h.driver.reader.observe(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({ success: false, reason: 'transaction failed' });
  });

  it('proves a token transfer that moved nothing failed (lesson 7)', async () => {
    const h = await driverFor(['main']);
    h.node.createMint(MINT, 6);
    h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    h.node.produce(2);
    const destination = associatedAddress(RECIPIENT, MINT);
    const id = h.node.submit(
      signedTx(h.node.head.hash, [
        createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
        transferChecked(
          associatedAddress(KEY_ADDRESS, MINT),
          MINT,
          destination,
          KEY_ADDRESS,
          0n,
          6,
        ),
      ]),
    );
    const ordering = expiryAt(h.node.head);
    h.node.produce(3);
    expect(h.node.landed(id)?.err).toBeNull();
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({ included: true, success: false, reason: 'token transfer failed' });
  });
});

describe('the Solana block source, when a block cannot be read whole', () => {
  it('decides nothing: the scan retries, never skips or stops (lesson 18)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(1);
    const { id } = transfer(h);
    h.node.produce(2);
    const header = await h.run(h.driver.blocks!.header(2n));
    const full = (params: readonly unknown[]) =>
      (params[1] as { transactionDetails?: string }).transactionDetails === 'full';
    h.node.intercept = (_endpoint, method, params) =>
      method === 'getBlock' && full(params)
        ? { error: { code: -32603, message: 'Internal error' } }
        : undefined;
    await expect(h.run(h.driver.blocks!.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // One transaction the decoder cannot read makes the whole block retry.
    h.node.intercept = (endpoint, method, params) => {
      if (method !== 'getBlock' || !full(params)) return undefined;
      const block = h.node.answer(endpoint, method, params) as {
        transactions: unknown[];
      };
      block.transactions.push({ meta: null, transaction: {} });
      return { result: block };
    };
    await expect(h.run(h.driver.blocks!.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.intercept = undefined;
    expect(
      (await h.run(h.driver.blocks!.transactions(header!))).map((tx) => tx.id),
    ).toEqual([id]);
  });
});
