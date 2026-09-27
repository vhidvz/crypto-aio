import {
  MASTERCHAIN_SHARD,
  MONITOR,
  PROOF,
  READ,
  TonApi,
  hashHex,
  rawOf,
} from '../../../src/adapters/ton/api';
import { nativeMessage } from '../../../src/adapters/ton/messages';
import type {
  CallOptions,
  HttpRequest,
  Transport,
} from '../../../src/core/transport/types';
import { signedBoc, testWallet, tonNode } from './support/harness';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const RECIPIENT = `0:${'11'.repeat(32)}`;
/** 32 zero bytes, as toncenter writes a hash (base64). */
const ZERO = `${'A'.repeat(43)}=`;

/** Records each call's route and tags (R41, R14). */
function recorded(transport: Transport) {
  const calls: { route?: string; path: string; options: CallOptions }[] = [];
  const proxy: Transport = new Proxy(transport, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'http' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (request: HttpRequest, options: CallOptions = {}) => {
        const { signal: _signal, quorumKey: _key, ...tags } = options;
        calls.push({
          ...(request.route !== undefined ? { route: request.route } : {}),
          path: request.path,
          options: tags,
        });
        return (value as Transport['http']).call(target, request, options);
      };
    },
  });
  return { proxy, calls };
}

async function withTransfer(t: ReturnType<typeof tonNode>) {
  const wallet = testWallet('v4r2', TESTNET);
  t.node.fund(wallet, 2n * GRAM);
  const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
    seqno: 0,
    validUntil: Math.floor(t.clock.now() / 1000) + 60,
    deploy: true,
    messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false, memo: 'x' })],
  });
  const sent = await t.run(
    t.api.send(boc, { purpose: 'broadcast', retry: 'ambiguous-on-failure' }),
  );
  t.node.mine(3);
  return { wallet, hashNorm, sent };
}

/** The scripted indexer's honest answer to a v3 query (read before any intercept). */
async function indexerBody(t: ReturnType<typeof tonNode>, path: string) {
  const response = await t.node.fetch.fetch(`${t.node.endpoint('main', 'v3')}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

const malformedAnswer = {
  code: 'PROVIDER_UNAVAILABLE',
  retryable: true,
  message: expect.stringContaining('malformed toncenter answer'),
};

describe('the toncenter API layer', () => {
  it('reads v2 state, heads, headers, shards and config through the rpc transport', async () => {
    const t = tonNode();
    const wallet = testWallet('v4r2', TESTNET);
    t.node.fund(wallet, GRAM);
    t.node.mine();
    const head = await t.run(t.api.masterchainHead(MONITOR));
    expect(head).toBe(t.node.head);
    const header = await t.run(t.api.masterchainHeader(head, PROOF));
    expect(header).toMatchObject({
      id: { workchain: -1, seqno: head, rootHash: t.node.block(head)?.rootHash },
      globalId: TESTNET,
      genUtime: t.node.block(head)?.genUtime,
    });
    const [shard] = await t.run(t.api.shards(head, PROOF));
    expect(shard).toMatchObject({ workchain: 0, seqno: head + 1000 });
    const account = await t.run(t.api.account(wallet, READ));
    expect(account).toMatchObject({
      balance: GRAM,
      status: 'uninitialized',
      blockSeqno: head,
    });
    expect(await t.run(t.api.configParam(19, READ))).toMatch(/^te6cc/);
    const seqno = await t.run(t.api.runGetMethod(wallet, 'seqno', [], READ));
    expect(seqno).toEqual({ exitCode: -13, stack: [] });
  });

  it('sends and finds the transaction, its trace and the account history through the indexer', async () => {
    const t = tonNode();
    const { wallet, hashNorm, sent } = await withTransfer(t);
    expect(sent.hashNorm).toBe(hashNorm);
    const [tx] = await t.run(t.api.transactionsByMessage(hashNorm, MONITOR));
    expect(tx).toMatchObject({
      account: wallet,
      mcSeqno: 2,
      aborted: false,
      compute: { success: true },
      action: { success: true, skippedActions: 0, msgsCreated: 1 },
      inMsg: { source: null, hashNorm },
      outMsgs: [{ destination: RECIPIENT, value: GRAM, bounce: false }],
    });
    expect(await t.run(t.api.transaction(tx!.hash, READ))).toEqual(tx);
    const trace = await t.run(t.api.trace(tx!.hash, MONITOR));
    expect(trace).toMatchObject({
      complete: true,
      transactions: [{ account: wallet }, { account: RECIPIENT }],
    });
    expect(
      await t.run(t.api.accountTransactions(RECIPIENT, { limit: 5 }, READ)),
    ).toHaveLength(1);
    expect(await t.run(t.api.reachedMasterchain(t.node.head, PROOF))).toBe(true);
    expect(await t.run(t.api.reachedMasterchain(t.node.head + 1, PROOF))).toBe(false);
  });

  it('tags every call per the ChainDriver table and labels it with a route', async () => {
    const t = tonNode();
    const rpc = recorded(t.rpc);
    const indexer = recorded(t.indexer);
    const api = new TonApi(rpc.proxy, indexer.proxy);
    await t.run(api.masterchainHead(MONITOR));
    await t.run(api.masterchainHeader(1, PROOF));
    await t.run(api.transactionsByMessage('ab'.repeat(32), MONITOR));
    // A12: every call reads integers exactly (toncenter writes some u64 values as numbers).
    expect(rpc.calls).toEqual([
      {
        route: '/getMasterchainInfo',
        path: '/getMasterchainInfo',
        options: { ...MONITOR, exactIntegers: true },
      },
      {
        route: '/getBlockHeader',
        path: '/getBlockHeader',
        options: { ...PROOF, exactIntegers: true },
      },
    ]);
    expect(indexer.calls).toEqual([
      {
        route: '/transactionsByMessage',
        path: '/transactionsByMessage',
        options: { ...MONITOR, exactIntegers: true },
      },
    ]);
  });

  it('turns a malformed answer into a retryable PROVIDER_UNAVAILABLE (lesson 6)', async () => {
    const t = tonNode();
    t.node.intercept = (_endpoint, route) =>
      route === '/getMasterchainInfo'
        ? { json: { ok: true, result: { last: { seqno: 'x' } } } }
        : route === '/masterchainInfo'
          ? { json: { first: {} } }
          : route === '/getAddressInformation'
            ? { json: { ok: false, error: 'x' } }
            : undefined;
    const calls: Promise<unknown>[] = [
      t.api.masterchainHead(MONITOR),
      t.api.indexerHead(MONITOR),
      t.api.account(RECIPIENT, READ),
    ];
    for (const call of calls) {
      await expect(t.run(call)).rejects.toMatchObject(malformedAnswer);
    }
  });

  it('agrees across endpoints that format alike facts differently, and not on other facts', async () => {
    const t = tonNode({}, ['a', 'b']);
    t.node.mine();
    const head = t.node.head;
    t.node.intercept = (endpoint, route, request) => {
      if (endpoint !== 'b' || route !== '/getBlockHeader') return undefined;
      const block = t.node.block(Number(request.url.searchParams.get('seqno')))!;
      const id = {
        workchain: -1,
        shard: '-9223372036854775808',
        seqno: block.seqno,
        root_hash: Buffer.from(block.rootHash, 'hex').toString('base64'),
        file_hash: Buffer.from(block.fileHash, 'hex').toString('base64'),
      };
      return {
        json: {
          ok: true,
          result: {
            '@type': 'blocks.header',
            id,
            global_id: -3,
            gen_utime: String(block.genUtime), // M5: a string where toncenter writes a number
            extra: 1,
            prev_blocks: [],
          },
          '@extra': 'other',
        },
      };
    };
    await expect(t.run(t.api.masterchainHeader(head, PROOF))).resolves.toMatchObject({
      id: { seqno: head },
    });
    t.node.intercept = (endpoint, route) =>
      endpoint === 'b' && route === '/getBlockHeader'
        ? {
            json: {
              ok: true,
              result: {
                id: {
                  workchain: -1,
                  shard: '-9223372036854775808',
                  seqno: head,
                  root_hash: ZERO,
                  file_hash: ZERO,
                },
                global_id: -3,
                gen_utime: 1,
              },
            },
          }
        : undefined;
    await expect(t.run(t.api.masterchainHeader(head, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it("attests a caller's predicate across endpoints at different heights (lesson 17)", async () => {
    const t = tonNode({}, ['a', 'b']);
    t.node.fund(testWallet('v4r2', TESTNET), GRAM);
    t.node.mine(5);
    t.node.lagEndpoint('b', 2);
    const head = t.node.head;
    // The heads differ, yet both endpoints hold block head - 2: the predicate agrees.
    await expect(t.run(t.api.reachedMasterchain(head - 2, PROOF))).resolves.toBe(true);
    // Only one endpoint holds the head: the quorum decides nothing.
    await expect(t.run(t.api.reachedMasterchain(head, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
    // A caller's key replaces a method's consensus facts: balances differ at the heads.
    const wallet = testWallet('v4r2', TESTNET);
    t.node.fund(wallet, GRAM);
    await expect(
      t.run(
        t.api.account(wallet, {
          ...PROOF,
          quorumKey: (body) =>
            (body as { result: { state: string } }).result.state === 'uninitialized',
        }),
      ),
    ).resolves.toMatchObject({ status: 'uninitialized' });
  });

  it('keys a trace on every fact a verdict reads, not only its hashes (C1)', async () => {
    const t = tonNode({}, ['a', 'b']);
    const { hashNorm } = await withTransfer(t);
    const [tx] = await t.run(t.api.transactionsByMessage(hashNorm, READ));
    await expect(t.run(t.api.trace(tx!.hash, PROOF))).resolves.toMatchObject({
      complete: true,
    });
    // Endpoint `a` answers first and flips one delivery into a bounce, hashes unchanged.
    t.node.intercept = (endpoint, route, request) => {
      if (endpoint !== 'a' || route !== '/traces') return undefined;
      t.node.intercept = undefined;
      const honest = t.node.fetch.fetch(request.url.href.replace('://a.', '://b.'));
      return honest.then(async (response) => {
        const body = (await response.json()) as {
          traces: {
            transactions: Record<string, { description: Record<string, unknown> }>;
          }[];
        };
        for (const one of Object.values(body.traces[0]!.transactions)) {
          one.description = { ...one.description, aborted: true, bounce: { type: 'ok' } };
        }
        return { json: body };
      });
    };
    await expect(t.run(t.api.trace(tx!.hash, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
  });

  it('turns a definitive 4xx to a state read into "decide nothing" (M2)', async () => {
    const t = tonNode();
    t.node.intercept = (_endpoint, route) =>
      route === '/getBlockHeader'
        ? { status: 400, json: { ok: false, error: 'block not found', code: 400 } }
        : undefined;
    await expect(t.run(t.api.masterchainHeader(1, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(t.run(t.api.masterchainHeader(1, READ))).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
    expect(t.api.lagTolerance).toBe(t.rpc.maxLagBlocks);
  });

  it('never counts an emulated transaction as chain evidence', async () => {
    const t = tonNode();
    const { hashNorm } = await withTransfer(t);
    const real = await t.run(t.api.transactionsByMessage(hashNorm, READ));
    t.node.intercept = (_endpoint, route) =>
      route === '/transactionsByMessage'
        ? { json: { transactions: [{ emulated: true }], address_book: {} } }
        : undefined;
    expect(real).toHaveLength(1);
    expect(await t.run(t.api.transactionsByMessage(hashNorm, READ))).toEqual([]);
  });

  it('reads u64 values that toncenter writes as JSON numbers exactly (A12)', async () => {
    const t = tonNode();
    const huge = '18446744073709551615';
    t.node.intercept = (_endpoint, route) =>
      route === '/estimateFee'
        ? {
            text: `{"ok":true,"result":{"source_fees":{"in_fwd_fee":${huge},"storage_fee":0,"gas_fee":1,"fwd_fee":2}}}`,
          }
        : route === '/getBlockHeader'
          ? {
              text: `{"ok":true,"result":{"id":{"workchain":-1,"shard":-9223372036854775808,"seqno":1,"root_hash":"${ZERO}","file_hash":"${ZERO}"},"global_id":-3,"gen_utime":1}}`,
            }
          : undefined;
    await expect(
      t.run(t.api.estimateFee({ address: RECIPIENT, body: 'te6cc' }, READ)),
    ).resolves.toEqual({
      importFee: BigInt(huge),
      storageFee: 0n,
      gasFee: 1n,
      forwardFee: 2n,
    });
    // The masterchain shard (-2^63) as a number, read exactly into its canonical text.
    const header = await t.run(t.api.masterchainHeader(1, READ));
    expect(header.id.shard).toBe(MASTERCHAIN_SHARD);
  });

  it('caps untrusted numbers before converting them (lesson 20)', async () => {
    const t = tonNode();
    let balance = '';
    let num = '';
    t.node.intercept = (_endpoint, route) =>
      route === '/getAddressInformation'
        ? {
            json: {
              ok: true,
              result: {
                balance,
                state: 'active',
                last_transaction_id: { lt: '1', hash: ZERO },
                block_id: {
                  workchain: -1,
                  shard: MASTERCHAIN_SHARD,
                  seqno: 1,
                  root_hash: ZERO,
                  file_hash: ZERO,
                },
                sync_utime: 1,
              },
            },
          }
        : route === '/runGetMethod'
          ? { json: { ok: true, result: { exit_code: 0, stack: [['num', num]] } } }
          : undefined;
    // The accepted ends: the largest coins value, and a 257-bit TVM integer.
    balance = (2n ** 120n - 1n).toString();
    await expect(t.run(t.api.account(RECIPIENT, READ))).resolves.toMatchObject({
      balance: 2n ** 120n - 1n,
    });
    num = `-0x${'f'.repeat(64)}`;
    await expect(
      t.run(t.api.runGetMethod(RECIPIENT, 'seqno', [], READ)),
    ).resolves.toEqual({
      exitCode: 0,
      stack: [{ type: 'num', value: -(2n ** 256n - 1n) }],
    });
    // 100,000 digits are refused before any conversion.
    balance = '9'.repeat(100_000);
    await expect(t.run(t.api.account(RECIPIENT, READ))).rejects.toMatchObject(
      malformedAnswer,
    );
    num = `0x${'f'.repeat(100_000)}`;
    await expect(
      t.run(t.api.runGetMethod(RECIPIENT, 'seqno', [], READ)),
    ).rejects.toMatchObject(malformedAnswer);
  });

  it('refuses an answer about other transactions, or one listed twice', async () => {
    const t = tonNode();
    const { wallet, hashNorm } = await withTransfer(t);
    const [tx] = await t.run(t.api.transactionsByMessage(hashNorm, READ));
    const [delivery] = await t.run(
      t.api.accountTransactions(RECIPIENT, { limit: 5 }, READ),
    );
    const theirs = await indexerBody(t, `/transactions?account=${RECIPIENT}&limit=5`);
    const ours = await indexerBody(t, `/transactions?account=${wallet}&limit=5`);
    const trace = await indexerBody(t, `/traces?tx_hash=${tx!.hash}`);
    let answer: unknown;
    t.node.intercept = (_endpoint, route) =>
      route === '/transactions' || route === '/traces' ? { json: answer } : undefined;
    // An indexer that drops a filter answers with other transactions: never evidence.
    answer = theirs;
    await expect(t.run(t.api.transaction(tx!.hash, READ))).rejects.toMatchObject(
      malformedAnswer,
    );
    await expect(
      t.run(t.api.accountTransactions(wallet, { limit: 5 }, READ)),
    ).rejects.toMatchObject(malformedAnswer);
    await expect(
      t.run(
        t.api.accountTransactions(
          RECIPIENT,
          { limit: 5, endLt: delivery!.lt - 1n },
          READ,
        ),
      ),
    ).rejects.toMatchObject(malformedAnswer);
    const [own] = ours.transactions as unknown[];
    answer = { ...ours, transactions: [own, own] };
    await expect(
      t.run(t.api.accountTransactions(wallet, { limit: 5 }, READ)),
    ).rejects.toMatchObject(malformedAnswer);
    answer = { ...ours, transactions: [own] };
    await expect(
      t.run(t.api.accountTransactions(wallet, { limit: 0 }, READ)),
    ).rejects.toMatchObject(malformedAnswer); // more than asked for
    await expect(
      t.run(t.api.accountTransactions(wallet, { limit: 5 }, READ)),
    ).resolves.toHaveLength(1);
    // A trace must hold the transaction asked about, each transaction once, under its hash.
    answer = trace;
    await expect(t.run(t.api.trace('cd'.repeat(32), READ))).rejects.toMatchObject(
      malformedAnswer,
    );
    const [one] = trace.traces as {
      transactions_order: string[];
      transactions: Record<string, unknown>;
    }[];
    const [first, second] = one!.transactions_order;
    answer = {
      ...trace,
      traces: [{ ...one, transactions_order: [first, first, second] }],
    };
    await expect(t.run(t.api.trace(tx!.hash, READ))).rejects.toMatchObject(
      malformedAnswer,
    );
    answer = {
      ...trace,
      traces: [
        {
          ...one,
          transactions: {
            [first!]: one!.transactions[second!],
            [second!]: one!.transactions[first!],
          },
        },
      ],
    };
    await expect(t.run(t.api.trace(tx!.hash, READ))).rejects.toMatchObject(
      malformedAnswer,
    );
    answer = trace;
    await expect(t.run(t.api.trace(tx!.hash, READ))).resolves.toMatchObject({
      complete: true,
    });
  });

  it('converts hashes and addresses strictly', () => {
    const hex = 'fc9b45a62efb7b39f91df4df72be1bb0e2b227e80bcaeb348fcb67b89840aa85';
    expect(hashHex('/JtFpi77ezn5HfTfcr4bsOKyJ+gLyus0j8tnuJhAqoU=')).toBe(hex);
    expect(hashHex('_JtFpi77ezn5HfTfcr4bsOKyJ-gLyus0j8tnuJhAqoU')).toBe(hex);
    expect(hashHex(hex.toUpperCase())).toBe(hex);
    expect(hashHex('AAAA')).toBeUndefined();
    expect(hashHex(7)).toBeUndefined();
    expect(hashHex('A'.repeat(100_000))).toBeUndefined();
    expect(rawOf(`0:${'AB'.repeat(32)}`)).toBe(`0:${'ab'.repeat(32)}`);
    expect(rawOf(null)).toBeNull();
    expect(rawOf('EQ..')).toBeUndefined();
    expect(rawOf(`0:${'a'.repeat(100_000)}`)).toBeUndefined();
  });

  it('waits on no real timer (lesson 1)', async () => {
    const spy = jest.spyOn(globalThis, 'setTimeout');
    try {
      const t = tonNode();
      await withTransfer(t);
      await t.run(t.api.masterchainHead(MONITOR));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
