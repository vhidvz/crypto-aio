import { sha256 } from '@noble/hashes/sha256';
import { toHexAddress } from '../../../src/adapters/tron/address';
import { encodeTransfer } from '../../../src/adapters/tron/abi';
import { createTronBuilder } from '../../../src/adapters/tron/builder';
import type { RpcBlock, TronApi, TronBlockHeader } from '../../../src/adapters/tron/http';
import { MAX_EXPIRATION_MS } from '../../../src/adapters/tron/network';
import {
  createTronBlocks,
  createTronHistory,
  createTronProofs,
} from '../../../src/adapters/tron/proofs';
import { createTronReader } from '../../../src/adapters/tron/reader';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { OrderingData } from '../../../src/core/model/ordering';
import { toHex, utf8ToBytes } from '../../../src/core/util/bytes';
import type { Clock } from '../../../src/core/util/clock';
import type { FakeReply, FakeRequest } from '../../../src/testing/fake-fetch';
import { submit, tronHarness } from './support/context';
import { signWithKey } from './support/signing';
import { KEY_ADDRESS, RECIPIENT, USDT } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'tx-hash' as const, canonical: true });
/** java-tron's TaPoS window: a reference block stays valid for the next 65,536 blocks. */
const TAPOS = 65_536n;

function setup(endpoints: readonly string[] = ['a', 'b']) {
  const h = tronHarness({ endpoints, node: { solidDepth: 3 } });
  h.node.fund(KEY_ADDRESS, 100_000_000n);
  h.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
  h.node.mintToken(USDT, KEY_ADDRESS, 1_000n);
  const proofs = createTronProofs(h.ctx);
  /** Mines one block per 3 fake seconds. */
  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await h.clock.advance(3_000);
      h.node.mine();
    }
  };
  /** The height of the block a transaction references (TaPoS). */
  const referenced = (raw: { refBlockBytes: string; refBlockHash: string }): number => {
    for (let n = h.node.head; n >= 0; n--) {
      const id = h.node.block(n)?.id ?? '';
      if (
        id.slice(12, 16) === raw.refBlockBytes &&
        id.slice(16, 32) === raw.refBlockHash
      ) {
        return n;
      }
    }
    throw new Error('no reference block');
  };
  /**
   * The ordering the builder records: the signed expiration and the TaPoS bound of the
   * reference block. `submit` references the head, 60 s from its time, so a transaction still
   * in the pool is read off the head right after it was submitted.
   */
  const ordering = (id: string): OrderingData => {
    const tx = h.node.transaction(id);
    const head = h.node.block(h.node.head) as { timestamp: number };
    return {
      kind: 'expiry',
      expiresAtMs: tx ? tx.raw.expiration : head.timestamp + 60_000,
      lastValidHeight: BigInt(tx ? referenced(tx.raw) : h.node.head) + TAPOS,
    };
  };
  return { ...h, proofs, mine, ordering };
}

/** One mutable intercept per endpoint (intercepts accumulate; the first reply wins). */
function lagIndex(h: ReturnType<typeof setup>) {
  const state = { lagging: true };
  for (const e of ['a', 'b']) {
    h.node.intercept(e, '/walletsolidity/gettransactioninfobyid', () =>
      state.lagging ? { json: {} } : undefined,
    );
  }
  return state;
}

describe('Tron proofs', () => {
  it('proves a solidified TRX transfer included, with its block hash, under the proof quorum', async () => {
    const h = setup();
    const id = await submit(h, 'trx');
    await h.mine(1);
    await expect(
      h.run(h.proofs.includedFinal(ref(id), h.ordering(id), KEY_ADDRESS)),
    ).rejects.toMatchObject({
      retryable: true,
    });
    await h.mine(3);
    expect(
      await h.run(h.proofs.includedFinal(ref(id), h.ordering(id), KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: true,
      blockHeight: 1n,
      blockHash: h.node.block(1)?.id,
      txHash: id,
    });
    const infoReads = h.calls.filter(
      (c) => c.path === '/walletsolidity/gettransactioninfobyid',
    );
    expect(
      infoReads.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
  });

  it('proves failure, with its reason, for OUT_OF_ENERGY and for a token transfer with no Transfer log (lesson 7)', async () => {
    const h = setup();
    h.node.deployToken(RECIPIENT, { symbol: 'FAKE', decimals: 6, mode: 'no-log' });
    h.node.mintToken(RECIPIENT, KEY_ADDRESS, 100n);
    const low = await submit(h, 'trc20', { feeLimit: 1_000 });
    const phantom = await submit(h, 'trc20', {
      contract: {
        type: 'TriggerSmartContract',
        owner: toHexAddress(KEY_ADDRESS),
        contract: toHexAddress(RECIPIENT),
        data: encodeTransfer(RECIPIENT, 5n),
      },
    });
    await h.mine(4);
    for (const [id, reason] of [
      [low, 'out of energy'],
      [phantom, 'token transfer not evidenced'],
    ] as const) {
      expect(
        await h.run(h.proofs.includedFinal(ref(id), h.ordering(id), KEY_ADDRESS)),
      ).toMatchObject({
        included: true,
        success: false,
        reason,
      });
    }
  });

  it('decides nothing on a receipt its attested block cannot have produced', async () => {
    const h = setup();
    const id = await submit(h, 'trx');
    await h.mine(4);
    // Both endpoints agree on a receipt dated off its solidified block's time.
    for (const e of ['a', 'b']) {
      h.node.intercept(e, '/walletsolidity/gettransactioninfobyid', () => ({
        json: {
          id,
          blockNumber: 1,
          blockTimeStamp: (h.node.block(1)?.timestamp ?? 0) + 3_000,
          receipt: { net_usage: 268 },
        },
      }));
    }
    await expect(
      h.run(h.proofs.includedFinal(ref(id), h.ordering(id), KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('proves expiry only from a solidified block at or past the expiration (D3)', async () => {
    const h = setup();
    const ordering: OrderingData = {
      kind: 'expiry',
      expiresAtMs: (h.node.block(0)?.timestamp ?? 0) + 9_000,
    };
    await h.mine(3);
    expect(await h.run(h.proofs.expired(ordering))).toBe(false);
    await h.mine(3);
    expect(await h.run(h.proofs.expired(ordering))).toBe(true);
    expect(await h.run(h.proofs.expired({ kind: 'nonce', nonce: 1n }))).toBe(false);
    expect(await h.run(h.proofs.slotConsumed(ordering, KEY_ADDRESS, 'finalized'))).toBe(
      false,
    );
  });

  it('attests each fact at its own height; only a real disagreement decides nothing (lesson 17)', async () => {
    const h = setup();
    await h.mine(8); // head 8, solidified 5 on both endpoints
    const ordering: OrderingData = {
      kind: 'expiry',
      expiresAtMs: h.node.block(3)?.timestamp ?? 0, // block 3 is the first at the expiration
    };
    h.node.lag('b', 2); // b: solidified 3, still at or past the expiration
    expect(await h.run(h.proofs.expired(ordering))).toBe(true);
    h.node.lag('b', 3); // b: solidified 2, before the expiration
    await expect(h.run(h.proofs.expired(ordering))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    // The unanchored head trails one endpoint's view by 2 blocks, then is attested.
    h.node.lag('b', 1); // b: solidified 4; a's view 5, trailed to 3
    const head = await h.run(h.proofs.finalizedHead());
    expect(head.height).toBeLessThanOrEqual(3n);
    expect(head).toEqual({
      height: head.height,
      hash: h.node.block(Number(head.height))?.id,
      timestamp: h.node.block(Number(head.height))?.timestamp,
    });
    h.node.lag('b', 0);
    expect(await h.run(h.proofs.finalizedHead())).toMatchObject({
      height: 3n,
      hash: h.node.block(3)?.id,
    });
  });

  it('answers "not included" only after expiry is final and a scan from the reference block shows the transaction absent (lesson 16)', async () => {
    const h = setup();
    await h.mine(100);
    const unknown = 'ab'.repeat(32);
    const expiry: OrderingData = {
      kind: 'expiry',
      expiresAtMs: (h.node.block(h.node.head)?.timestamp ?? 0) + 60_000,
      lastValidHeight: 100n + TAPOS, // referencing block 100
    };
    await expect(
      h.run(h.proofs.includedFinal(ref(unknown), expiry, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await h.mine(25);
    const before = h.calls.length;
    expect(
      await h.run(h.proofs.includedFinal(ref(unknown), expiry, KEY_ADDRESS)),
    ).toEqual({ included: false });
    const scanned = h.calls.slice(before).filter((c) => c.path === '/jsonrpc');
    // From block 120, the first at the expiration, down to block 101, just above the
    // reference: every block that could hold the transaction, and no other.
    expect(scanned).toHaveLength(20);
    // Every read the proof made, solidity-scoped blocks included, is a proof quorum read.
    expect(
      h.calls
        .slice(before)
        .every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
    // Without the reference block, nothing bounds the scan from below: nothing is decided.
    await expect(
      h.run(
        h.proofs.includedFinal(
          ref(unknown),
          { kind: 'expiry', expiresAtMs: expiry.expiresAtMs },
          KEY_ADDRESS,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('answers "not included" without a scan when the expiration passed before the reference block', async () => {
    const h = setup();
    await h.mine(30);
    const before = h.calls.length;
    expect(
      await h.run(
        h.proofs.includedFinal(
          ref('cd'.repeat(32)),
          {
            kind: 'expiry',
            expiresAtMs: h.node.block(10)?.timestamp ?? 0,
            lastValidHeight: 20n + TAPOS,
          },
          KEY_ADDRESS,
        ),
      ),
    ).toEqual({ included: false });
    expect(h.calls.slice(before).filter((c) => c.path === '/jsonrpc')).toHaveLength(0);
  });

  it('scans from the first block at or past the expiration, across missed slots (D3)', async () => {
    const h = setup();
    await h.mine(2);
    const reference = h.node.head;
    // Valid through the block 5 slots on, which is the first at its expiration.
    const expiration = (h.node.block(reference)?.timestamp ?? 0) + 15_000;
    const id = await submit(h, 'trx', { expiration });
    const ordering: OrderingData = {
      kind: 'expiry',
      expiresAtMs: expiration,
      lastValidHeight: BigInt(reference) + TAPOS,
    };
    for (let i = 0; i < 4; i++) {
      await h.clock.advance(3_000);
      h.node.mine({ include: false });
    }
    await h.mine(1);
    expect(h.node.transaction(id)?.blockNumber).toBe(reference + 5);
    expect(h.node.block(reference + 5)?.timestamp).toBe(expiration);
    // Then 10 slots pass with no block: the solidified head's time overstates how many
    // blocks lie between it and the expiration.
    await h.clock.advance(30_000);
    await h.mine(4);
    lagIndex(h);
    await expect(
      h.run(h.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('never answers "not included" while the solidity index lags behind an included transaction', async () => {
    const h = setup();
    const id = await submit(h, 'trx');
    const ordering = h.ordering(id);
    await h.mine(30);
    lagIndex(h);
    await expect(
      h.run(h.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('lets no lying endpoint end the negative scan early (F4)', async () => {
    const h = setup();
    const id = await submit(h, 'trx');
    const ordering = h.ordering(id);
    await h.mine(30);
    // The index lags on both endpoints, so the scan must find the transaction by blocks.
    lagIndex(h);
    // One endpoint reports every block 10 minutes older: its scan would stop at once.
    h.node.lieAboutTimestamps('a', 600_000);
    await expect(
      h.run(h.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('starts the negative scan at the attested reference block, whatever the build-time head and clock claimed (F4-R12)', async () => {
    const h = setup();
    await h.mine(1); // genesis serves no timestamp: never a reference
    const LEAD = 360_000; // beyond MAX_EXPIRATION_MS
    // The driver's clock leads the chain by 6 minutes...
    const clock: Clock = {
      now: () => h.clock.now() + LEAD,
      sleep: (ms, signal) => h.clock.sleep(ms, signal),
    };
    const { builder, broadcaster } = createTronBuilder({ ...h.ctx, clock });
    // ...and, while it builds, every endpoint dates the head it serves 6 minutes ahead.
    let lying = true;
    const forwardDated = (request: FakeRequest): FakeReply | undefined => {
      if (!lying || request.json().id_or_num !== undefined) return undefined;
      const n = h.node.head;
      const head = h.node.block(n) as { id: string; timestamp: number };
      return {
        json: {
          blockID: head.id,
          block_header: {
            raw_data: {
              number: n,
              parentHash: h.node.block(n - 1)?.id,
              timestamp: head.timestamp + LEAD,
            },
          },
        },
      };
    };
    for (const e of ['a', 'b']) h.node.intercept(e, '/wallet/getblock', forwardDated);
    const intent: DriverIntent = {
      asset: 'native',
      outputs: [{ to: RECIPIENT, amount: 1_000n }],
      from: KEY_ADDRESS,
      fee: 'normal',
    };
    const build = { from: KEY_ADDRESS, keys: h.keys, wallet: {} };
    const fee = await h.run(builder.estimateFee(intent, build));
    const unsigned = await h.run(builder.build(intent, fee, build));
    lying = false;
    const signed = await h.run(builder.assemble(unsigned, await signWithKey(unsigned)));
    await h.run(broadcaster.broadcast(signed));
    const reference = h.node.head;
    expect(unsigned.ordering).toMatchObject({
      lastValidHeight: BigInt(reference) + TAPOS,
    });
    await h.mine(1);
    expect(h.node.transaction(signed.ref.id)?.blockNumber).toBe(reference + 1);
    const index = lagIndex(h);
    await h.mine(150); // past the expiration, solidified on both endpoints
    const { expiresAtMs } = unsigned.ordering as { expiresAtMs: number };
    // A floor derived from the expiration (expiration − MAX_EXPIRATION_MS) lies above the
    // block that holds the transfer: a scan from there would never see it.
    expect(expiresAtMs - MAX_EXPIRATION_MS).toBeGreaterThan(
      h.node.block(reference + 1)?.timestamp ?? Infinity,
    );
    expect(await h.run(h.proofs.expired(unsigned.ordering))).toBe(true);
    await expect(
      h.run(h.proofs.includedFinal(signed.ref, unsigned.ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    index.lagging = false;
    expect(
      await h.run(h.proofs.includedFinal(signed.ref, unsigned.ordering, KEY_ADDRESS)),
    ).toMatchObject({
      included: true,
      success: true,
      blockHeight: BigInt(reference + 1),
      txHash: signed.ref.id,
    });
  });

  it('serves block hashes at the latest and finalized levels', async () => {
    const h = setup();
    await h.mine(5);
    expect(await h.run(h.proofs.blockHash(4n, 'latest'))).toBe(h.node.block(4)?.id);
    expect(await h.run(h.proofs.blockHash(4n, 'finalized'))).toBeNull();
    expect(await h.run(h.proofs.blockHash(2n, 'finalized'))).toBe(h.node.block(2)?.id);
    expect(await h.run(h.proofs.blockHash(9n, 'latest'))).toBeNull();
  });
});

/**
 * A final chain of `length` blocks 3 s apart, served straight as `TronApi` reads (no node):
 * scans far longer than a scripted node can mine.
 */
function stubChain(
  length: number,
  options: { holds?: [number, string]; parentOf?: [number, string] } = {},
) {
  const T0 = 1_790_000_000_000;
  const id = (n: number) =>
    n.toString(16).padStart(16, '0') + toHex(sha256(utf8ToBytes(String(n)))).slice(16);
  const header = (n: number): TronBlockHeader => ({
    number: BigInt(n),
    id: id(n),
    parentId: n === 0 ? '0'.repeat(64) : id(n - 1),
    timestamp: T0 + 3_000 * n,
  });
  const reads: number[] = [];
  const api = {
    transactionInfo: () => Promise.resolve(null),
    block: (_scope: string, at: bigint | undefined) =>
      Promise.resolve(
        at === undefined
          ? header(length - 1)
          : at < BigInt(length)
            ? header(Number(at))
            : null,
      ),
    rpcBlock: (hash: string): Promise<RpcBlock | null> => {
      const n = Number(BigInt(`0x${hash.slice(0, 16)}`));
      if (n >= length || hash !== id(n)) return Promise.resolve(null);
      reads.push(n);
      return Promise.resolve({
        number: BigInt(n),
        hash,
        parentHash:
          options.parentOf?.[0] === n ? options.parentOf[1] : header(n).parentId,
        timestamp: header(n).timestamp,
        transactions: options.holds?.[0] === n ? [options.holds[1]] : [],
      });
    },
  } as unknown as TronApi;
  return { api, header, reads };
}

describe('Tron proofs: the scan window', () => {
  it('never scans above the TaPoS bound of the reference block', async () => {
    const h = setup();
    const tx = 'ef'.repeat(32);
    // The reference is block 10, so no block above 65,546 can hold the transaction, though
    // its expiration is only reached at block 69,990.
    const chain = stubChain(70_000, { holds: [65_545, tx] });
    const proofs = createTronProofs({ ...h.ctx, api: chain.api });
    const ordering: OrderingData = {
      kind: 'expiry',
      expiresAtMs: chain.header(69_990).timestamp,
      lastValidHeight: 10n + TAPOS,
    };
    await expect(
      proofs.includedFinal(ref(tx), ordering, KEY_ADDRESS),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(chain.reads).toEqual([65_546, 65_545]);
  });

  it('decides nothing when the scanned blocks do not chain down to the attested reference block', async () => {
    const h = setup();
    const chain = stubChain(40, { parentOf: [11, 'ee'.repeat(32)] });
    const proofs = createTronProofs({ ...h.ctx, api: chain.api });
    const ordering: OrderingData = {
      kind: 'expiry',
      expiresAtMs: chain.header(20).timestamp,
      lastValidHeight: 10n + TAPOS,
    };
    await expect(
      proofs.includedFinal(ref('ef'.repeat(32)), ordering, KEY_ADDRESS),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    expect(chain.reads).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  });
});

describe('Tron block source and history', () => {
  it('scans a block, filters by address, and refuses a block that changed', async () => {
    const h = setup(['a']);
    const blocks = createTronBlocks(h.ctx);
    const trx = await submit(h, 'trx');
    const token = await submit(h, 'trc20');
    await h.mine(1);
    const header = await h.run(blocks.header(1n));
    expect(header).toMatchObject({ height: 1n, hash: h.node.block(1)?.id });
    const all = await h.run(blocks.transactions(header as NonNullable<typeof header>));
    expect(all.map((t) => t.id).sort()).toEqual([trx, token].sort());
    expect(all.find((t) => t.id === token)?.transfers[0]).toMatchObject({
      locator: 'log:0',
      to: RECIPIENT,
    });
    const mine = await h.run(
      blocks.transactions(header as NonNullable<typeof header>, {
        addresses: [RECIPIENT],
      }),
    );
    expect(mine).toHaveLength(2);
    h.node.reorg(1);
    await expect(
      h.run(blocks.transactions(header as NonNullable<typeof header>)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    expect(await h.run(blocks.header(7n))).toBeNull();
  });

  it('never asks for the transactions of block 0 (F4-R7)', async () => {
    const h = setup(['a']);
    const blocks = createTronBlocks(h.ctx);
    const genesis = await h.run(blocks.header(0n));
    expect(genesis).toMatchObject({ height: 0n, hash: h.node.block(0)?.id });
    const before = h.calls.length;
    expect(
      await h.run(blocks.transactions(genesis as NonNullable<typeof genesis>)),
    ).toEqual([]);
    expect(h.calls.slice(before)).toEqual([]);
  });

  it('lists own transactions first, then TRC-20 receipts, on the indexer transport', async () => {
    const h = setup(['a']);
    h.node.fund(RECIPIENT, 50_000_000n);
    const sent = await submit(h, 'trc20');
    await h.mine(5);
    const reader = createTronReader(h.ctx);
    const history = createTronHistory(h.ctx, h.transport, (id) =>
      reader.getTransaction(id),
    );
    const first = await h.run(history.list(KEY_ADDRESS, { limit: 10 }));
    expect(first.items.map((t) => t.id)).toEqual([sent]);
    expect(first.next).toBe('x:');
    const second = await h.run(
      history.list(KEY_ADDRESS, { limit: 10, cursor: first.next as string }),
    );
    expect(second).toEqual({ items: [] });
    const receiver = await h.run(history.list(RECIPIENT, { limit: 10, cursor: 'x:' }));
    expect(receiver.items.map((t) => t.id)).toEqual([sent]);
    await expect(
      h.run(history.list(KEY_ADDRESS, { limit: 1, cursor: 'zz' })),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('pages on the raw page and its fingerprint, never on what is left after filtering', async () => {
    const h = setup(['a']);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await submit(h, 'trc20', { timestamp: 1 + i }));
    }
    await h.mine(5);
    const reader = createTronReader(h.ctx);
    const history = createTronHistory(h.ctx, h.transport, (id) =>
      reader.getTransaction(id),
    );
    const limits: string[] = [];
    h.node.intercept('a', `/v1/accounts/${KEY_ADDRESS}/transactions/trc20`, (request) => {
      limits.push(request.url.searchParams.get('limit') ?? '');
      return undefined;
    });
    // Phase x skips the sender's own transfers (phase t listed them): each page of one is
    // empty after filtering, yet the fingerprint carries the listing on.
    let cursor: string | undefined = 'x:';
    const pages: { readonly items: readonly unknown[]; readonly next?: string }[] = [];
    while (cursor !== undefined) {
      const page: { readonly items: readonly unknown[]; readonly next?: string } =
        await h.run(history.list(KEY_ADDRESS, { limit: 1, cursor }));
      pages.push(page);
      cursor = page.next;
    }
    expect(pages.map((p) => p.items.length)).toEqual([0, 0, 0]);
    expect(pages.map((p) => p.next)).toEqual(['x:1', 'x:2', undefined]);
    // A caller's limit is capped at TronGrid's 200.
    await h.run(history.list(KEY_ADDRESS, { limit: 5_000, cursor: 'x:' }));
    expect(limits).toEqual(['1', '1', '1', '200']);
    const own = await h.run(history.list(KEY_ADDRESS, { limit: 200 }));
    expect([...own.items.map((t) => t.id)].sort()).toEqual([...ids].sort());
  });

  it('decides nothing when the node cannot serve a transaction the index lists', async () => {
    const h = setup(['a']);
    await submit(h, 'trx');
    await h.mine(5);
    const reader = createTronReader(h.ctx);
    const history = createTronHistory(h.ctx, h.transport, (id) =>
      reader.getTransaction(id),
    );
    h.node.intercept('a', '/wallet/gettransactionbyid', () => ({ json: {} }));
    await expect(h.run(history.list(KEY_ADDRESS, { limit: 10 }))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});
