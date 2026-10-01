import { Cell, beginCell, loadMessage } from '@ton/core';
import {
  MASTERCHAIN_SHARD,
  MONITOR,
  PROOF,
  READ,
  TonApi,
  boundRunResultOf,
  hashHex,
  rawOf,
} from '../../../src/adapters/ton/api';
import { nativeMessage } from '../../../src/adapters/ton/messages';
import type {
  CallOptions,
  HttpRequest,
  Transport,
} from '../../../src/core/transport/types';
import { canonicalJson } from '../../../src/core/util/json';
import { signedBoc, testWallet, tonNode } from './support/harness';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const RECIPIENT = `0:${'11'.repeat(32)}`;
/** 32 zero bytes, as toncenter writes a hash (base64). */
const ZERO = `${'A'.repeat(43)}=`;
const MASTER = `0:${'77'.repeat(32)}`;
/** USDT's master in its user-friendly form: a valid address, but not the raw form. */
const FRIENDLY = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

interface Recorded {
  readonly route?: string;
  readonly path: string;
  readonly options: CallOptions;
  readonly quorumKey?: (result: unknown) => unknown;
  answer?: unknown;
}

/** Records each call's route, tags, quorum key and answer. */
function recorded(transport: Transport) {
  const calls: Recorded[] = [];
  const proxy: Transport = new Proxy(transport, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'http' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (request: HttpRequest, options: CallOptions = {}) => {
        const { signal: _signal, quorumKey, ...tags } = options;
        const call: Recorded = {
          ...(request.route !== undefined ? { route: request.route } : {}),
          path: request.path,
          options: tags,
          ...(quorumKey ? { quorumKey } : {}),
        };
        calls.push(call);
        call.answer = await (value as Transport['http']).call(target, request, options);
        return call.answer;
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

type Json = Record<string, unknown>;
/** A v3 transaction's description, and one of its phases. */
const desc = (tx: Json) => tx.description as Json;
const phase = (tx: Json, name: 'compute_ph' | 'action') => desc(tx)[name] as Json;

/** Our transfer's wallet transaction, parsed and as the indexer writes it. */
async function transferJson(t: ReturnType<typeof tonNode>) {
  const { wallet, hashNorm, sent } = await withTransfer(t);
  const [tx] = await t.run(t.api.transactionsByMessage(hashNorm, READ));
  const body = await indexerBody(t, `/transactions?hash=${tx!.hash}`);
  const [json] = body.transactions as Json[];
  return { wallet, hashNorm, sent, tx: tx!, json: json! };
}

/** A v2 account state answer with these amounts. */
function accountAnswer(balance: string, lt = '1') {
  return {
    ok: true,
    result: {
      balance,
      state: 'active',
      last_transaction_id: { lt, hash: ZERO },
      block_id: {
        workchain: -1,
        shard: MASTERCHAIN_SHARD,
        seqno: 1,
        root_hash: ZERO,
        file_hash: ZERO,
      },
      sync_utime: 1,
    },
  };
}

/** A BOC header (magic b5ee9c72, 3-byte counts) declaring `cells` cells: 16 characters. */
function stateHeader(cells: number): string {
  return Buffer.from([
    0xb5,
    0xee,
    0x9c,
    0x72,
    0x03,
    0x01,
    cells >> 16,
    (cells >> 8) & 0xff,
    cells & 0xff,
    0,
    0,
    0,
  ]).toString('base64');
}

/** A BOC header (magic b5ee9c72, 2-byte counts) declaring `cells` cells. */
function bocHeader(cells: number): string {
  return Buffer.from([
    0xb5,
    0xee,
    0x9c,
    0x72,
    0x02,
    0x01,
    cells >> 8,
    cells & 0xff,
    0,
    0,
  ]).toString('base64');
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

  it('tags all 22 calls per the ChainDriver table, labels each with a route and keys its facts', async () => {
    const t = tonNode();
    t.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'offchain' });
    const { wallet, hashNorm } = await withTransfer(t);
    const next = await signedBoc('v4r2', TESTNET, {
      seqno: 1,
      validUntil: Math.floor(t.clock.now() / 1000) + 60,
      deploy: false,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    const body = loadMessage(
      Cell.fromBoc(Buffer.from(next.boc, 'base64'))[0]!.beginParse(),
    )
      .body.toBoc()
      .toString('base64');
    const rpc = recorded(t.rpc);
    const indexer = recorded(t.indexer);
    const api = new TonApi(rpc.proxy, indexer.proxy);
    const head = await t.run(api.masterchainHead(PROOF));
    await t.run(api.reachedMasterchain(head, PROOF));
    const [shard] = await t.run(api.shards(head, PROOF));
    await t.run(api.blockHeader(shard!, PROOF));
    const header = await t.run(api.masterchainHeader(head, PROOF));
    await t.run(api.configParam(19, PROOF));
    const state = await t.run(api.account(wallet, PROOF));
    await t.run(api.runGetMethod(wallet, 'seqno', [], PROOF));
    await t.run(api.runGetMethodAt(wallet, 'seqno', [], PROOF, head));
    expect(
      await t.run(
        api.rawTransactions(wallet, { lt: state.lastLt, hash: state.lastHash }, 4, PROOF),
      ),
    ).toHaveLength(1);
    expect(await t.run(api.jettonData(MASTER, PROOF))).toMatchObject({
      exitCode: 0,
      content: { kind: 'cell' },
    });
    await t.run(api.estimateFee({ address: wallet, body }, PROOF));
    await t.run(api.send(next.boc, PROOF));
    await t.run(api.indexerHead(PROOF));
    expect(await t.run(api.indexerReached(head, PROOF))).toBe(true);
    expect(await t.run(api.masterchainSeqnoOf(header.id.rootHash, PROOF))).toBe(head);
    const [tx] = await t.run(api.transactionsByMessage(hashNorm, PROOF));
    expect(await t.run(api.transaction(tx!.hash, PROOF))).toEqual(tx);
    await t.run(api.accountTransactions(wallet, { limit: 5 }, PROOF));
    await t.run(api.accountTransactionsPage(wallet, { limit: 5 }, PROOF));
    await t.run(api.trace(tx!.hash, PROOF));
    expect(await t.run(api.tokenInfo(MASTER, PROOF))).toEqual({
      symbol: 'TST',
      decimals: '6',
    });
    expect(rpc.calls.map((call) => call.route)).toEqual([
      '/getMasterchainInfo',
      '/getMasterchainInfo',
      '/getShards',
      '/getBlockHeader',
      '/getBlockHeader',
      '/getConfigParam',
      '/getAddressInformation',
      '/runGetMethod',
      '/runGetMethod',
      '/getTransactions',
      '/runGetMethod',
      '/estimateFee',
      '/sendBocReturnHash',
    ]);
    expect(indexer.calls.map((call) => call.route)).toEqual([
      '/masterchainInfo',
      '/masterchainInfo',
      '/blocks',
      '/transactionsByMessage',
      '/transactions',
      '/transactions',
      '/transactions',
      '/traces',
      '/metadata',
    ]);
    for (const call of [...rpc.calls, ...indexer.calls]) {
      expect(call.path).toBe(call.route);
      // Every call reads integers exactly (toncenter writes some u64 values as numbers).
      expect(call.options).toEqual({ ...PROOF, exactIntegers: true });
      // A default key over the parsed facts reaches the transport; it reads neither the
      // envelope (v2's `@extra`) nor fields the method does not read.
      expect(call.quorumKey).toEqual(expect.any(Function));
      const facts = canonicalJson(call.quorumKey!(call.answer));
      const reformatted = { ...(call.answer as object), '@extra': 'other', unread: 1 };
      expect(canonicalJson(call.quorumKey!(reformatted))).toBe(facts);
    }
    // A read without a quorum carries no key.
    await t.run(api.masterchainHead(MONITOR));
    expect(rpc.calls.at(-1)?.options).toEqual({ ...MONITOR, exactIntegers: true });
    expect(rpc.calls.at(-1)?.quorumKey).toBeUndefined();
  });

  it('turns a malformed answer into a retryable PROVIDER_UNAVAILABLE', async () => {
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

  it("reads every masterchain head with the probes' own strict parser", async () => {
    const t = tonNode();
    t.node.mine(3);
    const mc = { workchain: -1, shard: '-9223372036854775808', seqno: 42 };
    const v3 = { workchain: -1, seqno: 42, global_id: -3 };
    let v2Last: unknown = mc;
    let v3Last: unknown = v3;
    t.node.intercept = (_endpoint, route) =>
      route === '/getMasterchainInfo'
        ? { json: { ok: true, result: { last: v2Last } } }
        : route === '/masterchainInfo'
          ? { json: { last: v3Last } }
          : undefined;
    expect(await t.run(t.api.masterchainHead(MONITOR))).toBe(42);
    expect(await t.run(t.api.reachedMasterchain(42, MONITOR))).toBe(true);
    expect(await t.run(t.api.indexerHead(MONITOR))).toEqual({ seqno: 42, globalId: -3 });
    expect(await t.run(t.api.indexerReached(43, MONITOR))).toBe(false);
    // A block of another workchain, or a seqno beyond a u32, is no masterchain head.
    for (const bad of [{ workchain: 0 }, { seqno: 2 ** 32 }, { seqno: -1 }]) {
      v2Last = { ...mc, ...bad };
      v3Last = { ...v3, ...bad };
      for (const call of [
        (): Promise<unknown> => t.api.masterchainHead(MONITOR),
        (): Promise<unknown> => t.api.reachedMasterchain(1, MONITOR),
        (): Promise<unknown> => t.api.indexerHead(MONITOR),
        (): Promise<unknown> => t.api.indexerReached(1, MONITOR),
      ]) {
        await expect(t.run(call())).rejects.toMatchObject(malformedAnswer);
      }
    }
    // The indexer's global id is an int32.
    v3Last = { ...v3, global_id: 2 ** 31 };
    await expect(t.run(t.api.indexerHead(MONITOR))).rejects.toMatchObject(
      malformedAnswer,
    );
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
            gen_utime: String(block.genUtime), // a string where toncenter writes a number
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

  it("attests a caller's predicate across endpoints at different heights", async () => {
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

  it('keys a trace on every fact a verdict reads, not only its hashes', async () => {
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

  // TON's negatives come only from attested state, never from an error of any text.
  it('turns a definitive 4xx to a state read into "decide nothing"', async () => {
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

  it('counts only a finalized transaction as chain evidence (v3 finality)', async () => {
    const t = tonNode();
    const { hashNorm } = await withTransfer(t);
    const [tx] = await t.run(t.api.transactionsByMessage(hashNorm, READ));
    const byMessage = await indexerBody(t, `/transactionsByMessage?msg_hash=${hashNorm}`);
    const traces = await indexerBody(t, `/traces?tx_hash=${tx!.hash}`);
    const [trace] = traces.traces as Json[];
    const members = trace!.transactions as Record<string, Json>;
    const delivery = (trace!.transactions_order as string[]).at(-1)!;
    let finality: unknown;
    const marked = (json: Json): Json => {
      const { finality: _live, ...rest } = json;
      return finality === undefined ? rest : { ...rest, finality };
    };
    t.node.intercept = (_endpoint, route) => {
      if (route === '/transactionsByMessage') {
        const listed = (byMessage.transactions as Json[]).map(marked);
        return { json: { ...byMessage, transactions: listed } };
      }
      if (route !== '/traces') return undefined;
      // Only the delivery: the trace still holds the transaction asked for.
      const transactions = { ...members, [delivery]: marked(members[delivery]!) };
      return { json: { ...traces, traces: [{ ...trace, transactions }] } };
    };
    // Live answers name the state; the swagger declares 0 pending, 1 confirmed, 2 finalized.
    for (finality of ['pending', 'confirmed', 0, 1, 'final']) {
      expect(await t.run(t.api.transactionsByMessage(hashNorm, READ))).toEqual([]);
      expect(await t.run(t.api.trace(tx!.hash, READ))).toMatchObject({ complete: false });
    }
    // An indexer that writes no `finality` (absent or null) still needs each
    // transaction's masterchain block.
    for (finality of ['finalized', 2, undefined, null]) {
      expect(await t.run(t.api.transactionsByMessage(hashNorm, READ))).toHaveLength(1);
      expect(await t.run(t.api.trace(tx!.hash, READ))).toMatchObject({ complete: true });
    }
  });

  it('reads u64 values that toncenter writes as JSON numbers exactly', async () => {
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

  it('caps untrusted numbers before converting them', async () => {
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

  it('binds lookups to the id asked, and refuses a history that breaks its query', async () => {
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
    // An indexer that drops a filter answers with other transactions: never evidence. A
    // lookup by id reads that as "none yet"; a history that breaks its query is malformed.
    answer = theirs;
    await expect(t.run(t.api.transaction(tx!.hash, READ))).resolves.toBeNull();
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
    await expect(t.run(t.api.trace('cd'.repeat(32), READ))).resolves.toBeNull();
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

  const DRIFTS: readonly (readonly [string, (tx: Json) => void])[] = [
    ['aborted is missing', (tx) => delete desc(tx).aborted],
    ['aborted is not a boolean', (tx) => (desc(tx).aborted = 'false')],
    ['description has no type', (tx) => delete desc(tx).type],
    ['ord description has no compute phase', (tx) => delete desc(tx).compute_ph],
    [
      'tick-tock description has no compute phase',
      (tx) => {
        desc(tx).type = 'tick_tock';
        delete desc(tx).compute_ph;
      },
    ],
    ['compute_ph.skipped is missing', (tx) => delete phase(tx, 'compute_ph').skipped],
    ['compute_ph.success is missing', (tx) => delete phase(tx, 'compute_ph').success],
    [
      'compute_ph.exit_code is not an integer',
      (tx) => (phase(tx, 'compute_ph').exit_code = 'x'),
    ],
    ['action phase is not a record', (tx) => (desc(tx).action = true)],
    ['action.success is missing', (tx) => delete phase(tx, 'action').success],
    ['action.result_code is missing', (tx) => delete phase(tx, 'action').result_code],
    [
      'action.skipped_actions is missing',
      (tx) => delete phase(tx, 'action').skipped_actions,
    ],
    ['action.msgs_created is missing', (tx) => delete phase(tx, 'action').msgs_created],
    ['bounce phase has an unknown type', (tx) => (desc(tx).bounce = { type: 'maybe' })],
    ['in_msg.hash_norm is not a hash', (tx) => ((tx.in_msg as Json).hash_norm = 'x')],
    [
      'outbound bounce flag is not a boolean',
      (tx) => ((tx.out_msgs as Json[])[0]!.bounce = 'no'),
    ],
  ];

  it.each(DRIFTS)(
    'reads a transaction whose %s as malformed, never as a default',
    async (_drift, change) => {
      const t = tonNode();
      const { tx, json } = await transferJson(t);
      const drifted = structuredClone(json);
      change(drifted);
      t.node.intercept = (_endpoint, route) =>
        route === '/transactions'
          ? { json: { transactions: [drifted], address_book: {} } }
          : undefined;
      await expect(t.run(t.api.transaction(tx.hash, READ))).rejects.toMatchObject(
        malformedAnswer,
      );
    },
  );

  it('reads what the chain writes: a skipped compute phase, a storage transaction, a bounce', async () => {
    const t = tonNode();
    const { tx, json } = await transferJson(t);
    let answer = json;
    t.node.intercept = (_endpoint, route) =>
      route === '/transactions'
        ? { json: { transactions: [answer], address_book: {} } }
        : undefined;
    answer = structuredClone(json);
    desc(answer).compute_ph = { skipped: true, reason: 'no_state' };
    delete desc(answer).action;
    desc(answer).bounce = { type: 'nofunds' };
    const skipped = await t.run(t.api.transaction(tx.hash, READ));
    expect(skipped).toMatchObject({
      compute: { skipped: true, success: false },
      bounce: 'nofunds',
    });
    expect(skipped?.action).toBeUndefined();
    answer = structuredClone(json);
    desc(answer).type = 'storage';
    delete desc(answer).compute_ph;
    delete desc(answer).action;
    await expect(t.run(t.api.transaction(tx.hash, READ))).resolves.toMatchObject({
      compute: { skipped: true, success: false },
    });
  });

  it('keeps only what a lookup by id asked for: a dropped filter reads as "none yet"', async () => {
    const t = tonNode();
    const { hashNorm, sent, tx, json } = await transferJson(t);
    const theirs = await indexerBody(t, `/transactions?account=${RECIPIENT}&limit=5`);
    const [stranger] = theirs.transactions as Json[];
    const header = await t.run(t.api.masterchainHeader(tx.mcSeqno, READ));
    const other = await t.run(t.api.masterchainHeader(tx.mcSeqno - 1, READ));
    const blocks = await indexerBody(
      t,
      `/blocks?workchain=-1&root_hash=${other.id.rootHash}&limit=1`,
    );
    let answer: unknown[] = [];
    t.node.intercept = (_endpoint, route) =>
      route === '/transactionsByMessage'
        ? { json: { transactions: answer, address_book: {} } }
        : route === '/blocks'
          ? { json: blocks }
          : undefined;
    answer = [stranger];
    await expect(t.run(t.api.transactionsByMessage(hashNorm, READ))).resolves.toEqual([]);
    answer = [stranger, json];
    await expect(t.run(t.api.transactionsByMessage(hashNorm, READ))).resolves.toEqual([
      tx,
    ]);
    await expect(t.run(t.api.transactionsByMessage(sent.hash, READ))).resolves.toEqual([
      tx,
    ]);
    answer = [{ ...json, in_msg: null }];
    await expect(t.run(t.api.transactionsByMessage(hashNorm, READ))).resolves.toEqual([]);
    // Another block than the root hash asked for: unknown, not another block's seqno.
    await expect(
      t.run(t.api.masterchainSeqnoOf(header.id.rootHash, READ)),
    ).resolves.toBeNull();
  });

  it('reads amounts as unsigned coins and logical times as u64', async () => {
    const t = tonNode();
    const { tx, json } = await transferJson(t);
    let account = accountAnswer('0');
    let answer = json;
    let fees: Json = {};
    t.node.intercept = (_endpoint, route) =>
      route === '/getAddressInformation'
        ? { json: account }
        : route === '/transactions'
          ? { json: { transactions: [answer], address_book: {} } }
          : route === '/estimateFee'
            ? { json: { ok: true, result: { source_fees: fees } } }
            : undefined;
    const refusedStates: [string, string][] = [
      ['-1', '1'],
      [(2n ** 120n).toString(), '1'],
      ['1', '-1'],
      ['1', (2n ** 64n).toString()],
    ];
    for (const [balance, lt] of refusedStates) {
      account = accountAnswer(balance, lt);
      await expect(t.run(t.api.account(RECIPIENT, READ))).rejects.toMatchObject(
        malformedAnswer,
      );
    }
    account = accountAnswer((2n ** 120n - 1n).toString(), (2n ** 64n - 1n).toString());
    await expect(t.run(t.api.account(RECIPIENT, READ))).resolves.toMatchObject({
      balance: 2n ** 120n - 1n,
      lastLt: 2n ** 64n - 1n,
    });
    const refusedTxs: ((tx: Json) => void)[] = [
      (tx) => (tx.total_fees = '-1'),
      (tx) => (tx.lt = '-1'),
      (tx) => (tx.lt = (2n ** 64n).toString()),
      (tx) => ((tx.out_msgs as Json[])[0]!.value = '-5'),
    ];
    for (const change of refusedTxs) {
      answer = structuredClone(json);
      change(answer);
      await expect(t.run(t.api.transaction(tx.hash, READ))).rejects.toMatchObject(
        malformedAnswer,
      );
    }
    fees = { in_fwd_fee: 0, storage_fee: 0, gas_fee: -1, fwd_fee: 0 };
    await expect(
      t.run(t.api.estimateFee({ address: RECIPIENT, body: 'te6cc' }, READ)),
    ).rejects.toMatchObject(malformedAnswer);
  });

  it('refuses a non-raw address before any request', async () => {
    const t = tonNode();
    const served = t.node.served.length;
    const calls: (() => Promise<unknown>)[] = [
      () => t.api.accountTransactions(FRIENDLY, { limit: 1 }, READ),
      () => t.api.accountTransactionsPage(FRIENDLY, { limit: 1 }, READ),
      () => t.api.tokenInfo(FRIENDLY, READ),
    ];
    for (const call of calls) {
      await expect(t.run(call())).rejects.toMatchObject({
        code: 'INVALID_ADDRESS',
        retryable: false,
      });
    }
    expect(t.node.served).toHaveLength(served);
  });

  it('refuses more items than a lookup asked for', async () => {
    const t = tonNode();
    t.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'offchain' });
    const { hashNorm, tx, json } = await transferJson(t);
    const header = await t.run(t.api.masterchainHeader(tx.mcSeqno, READ));
    const twice = async (path: string, field: string) => {
      const body = await indexerBody(t, path);
      const items = body[field] as unknown[];
      return { ...body, [field]: [...items, ...items] };
    };
    const answers: Json = {
      '/transactionsByMessage': {
        transactions: Array.from({ length: 9 }, () => json),
        address_book: {},
      },
      '/transactions': { transactions: [json, json], address_book: {} },
      '/traces': await twice(`/traces?tx_hash=${tx.hash}`, 'traces'),
      '/blocks': await twice(
        `/blocks?workchain=-1&root_hash=${header.id.rootHash}&limit=1`,
        'blocks',
      ),
    };
    t.node.intercept = (_endpoint, route) =>
      Object.hasOwn(answers, route) ? { json: answers[route] } : undefined;
    const calls: (() => Promise<unknown>)[] = [
      () => t.api.transactionsByMessage(hashNorm, READ),
      () => t.api.transaction(tx.hash, READ),
      () => t.api.trace(tx.hash, READ),
      () => t.api.masterchainSeqnoOf(header.id.rootHash, READ),
    ];
    for (const call of calls) {
      await expect(t.run(call())).rejects.toMatchObject(malformedAnswer);
    }
  });

  it('holds cells and jetton metadata to their limits', async () => {
    const t = tonNode();
    let bytes = '';
    let symbol: unknown = '';
    t.node.intercept = (_endpoint, route) =>
      route === '/getConfigParam'
        ? { json: { ok: true, result: { config: { bytes } } } }
        : route === '/runGetMethod'
          ? { json: { ok: true, result: { exit_code: 0, stack: [['cell', { bytes }]] } } }
          : route === '/metadata'
            ? {
                json: {
                  [MASTER]: { is_indexed: true, token_info: [{ valid: true, symbol }] },
                },
              }
            : undefined;
    const cells: (() => Promise<unknown>)[] = [
      () => t.api.configParam(19, READ),
      () => t.api.runGetMethod(MASTER, 'get_jetton_data', [], READ),
    ];
    // A message's worth of cells (2^13, read from the BOC header) is the accepted end.
    bytes = bocHeader(8192);
    for (const call of cells) await expect(t.run(call())).resolves.toBeDefined();
    for (const refused of [bocHeader(8193), 'A'.repeat(2 ** 19 + 4), 'not a BOC']) {
      bytes = refused;
      for (const call of cells) {
        await expect(t.run(call())).rejects.toMatchObject(malformedAnswer);
      }
    }
    // A symbol that is not one is the token's own data, which every endpoint agrees on:
    // reported as unreadable (null) for the caller to judge, never retried.
    for (const unreadable of ['S'.repeat(257), 7]) {
      symbol = unreadable;
      await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toEqual({
        symbol: null,
      });
    }
    symbol = 'S'.repeat(256);
    await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toEqual({ symbol });
  });

  it("reads a malformed metadata entry as malformed, and a stranger's as none yet", async () => {
    const t = tonNode();
    let metadata: Json = {};
    t.node.intercept = (_endpoint, route) =>
      route === '/metadata' ? { json: metadata } : undefined;
    // Another token's entry (a dropped filter) is "none yet", as no entry is.
    const other = `0:${'88'.repeat(32)}`;
    metadata = {
      [other]: { is_indexed: true, token_info: [{ valid: true, symbol: 'X' }] },
    };
    await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toBeUndefined();
    metadata = { [MASTER]: 7 };
    await expect(t.run(t.api.tokenInfo(MASTER, READ))).rejects.toMatchObject(
      malformedAnswer,
    );
  });

  // A pager that stopped on the length of a filtered page would end early and miss the
  // older transactions.
  it('pages an account on the page as served: a transaction not yet final never ends it', async () => {
    const t = tonNode();
    const { wallet } = await withTransfer(t);
    for (let i = 0; i < 3; i++) {
      t.node.inject(wallet, RECIPIENT, 1n, beginCell().endCell());
    }
    t.node.mine(2);
    const all = await t.run(t.api.accountTransactions(RECIPIENT, { limit: 10 }, READ));
    expect(all).toHaveLength(4);
    const [, second, third, oldest] = all;
    const first = await indexerBody(t, `/transactions?account=${RECIPIENT}&limit=2`);
    const [top, ...rest] = first.transactions as Json[];
    let newest: Json = { ...top, finality: 'pending' };
    t.node.intercept = (_endpoint, route, request) =>
      route === '/transactions' && !request.url.searchParams.has('end_lt')
        ? { json: { ...first, transactions: [newest, ...rest] } }
        : undefined;
    // The newest is not final yet: left out, yet the full page still leads to the next.
    const page = await t.run(
      t.api.accountTransactionsPage(RECIPIENT, { limit: 2 }, READ),
    );
    expect(page.transactions.map((tx) => tx.hash)).toEqual([second!.hash]);
    expect(page.next).toBe(second!.lt - 1n);
    const older = await t.run(
      t.api.accountTransactionsPage(RECIPIENT, { limit: 2, endLt: page.next! }, READ),
    );
    expect(older.transactions.map((tx) => tx.hash)).toEqual([third!.hash, oldest!.hash]);
    expect(older.next).toBe(oldest!.lt - 1n);
    // A page that is not full is the last one.
    expect(
      await t.run(
        t.api.accountTransactionsPage(RECIPIENT, { limit: 2, endLt: older.next! }, READ),
      ),
    ).toEqual({ transactions: [] });
    // A transaction not yet final still answers the query: another account's is malformed.
    newest = { ...top, finality: 'pending', account: wallet.toUpperCase() };
    await expect(
      t.run(t.api.accountTransactionsPage(RECIPIENT, { limit: 2 }, READ)),
    ).rejects.toMatchObject(malformedAnswer);
  });

  it("reads a jetton master's content cell, and one beyond an account state's limits as oversized", async () => {
    const t = tonNode();
    t.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    expect(await t.run(t.api.jettonData(MASTER, READ))).toMatchObject({
      exitCode: 0,
      content: { kind: 'cell' },
    });
    expect(await t.run(t.api.jettonData(RECIPIENT, READ))).toEqual({ exitCode: -13 });
    let stack: unknown[] = [];
    t.node.intercept = (_endpoint, route) =>
      route === '/runGetMethod'
        ? { json: { ok: true, result: { exit_code: 0, stack } } }
        : undefined;
    // Only the content is read: the supply and the wallet code are held to nothing.
    const withContent = (bytes: string) => [
      ['num', 'not read'],
      ['num', '-0x1'],
      ['cell', { bytes: 'not read' }],
      ['cell', { bytes }],
      ['cell', { bytes: 'not read' }],
    ];
    // The content is part of the master's state: more cells than a message may hold are
    // read, up to the state's 2^16 cells (config param 43) and 2^24 characters.
    for (const cells of [8193, 2 ** 16]) {
      stack = withContent(stateHeader(cells));
      expect(await t.run(t.api.jettonData(MASTER, READ))).toEqual({
        exitCode: 0,
        content: { kind: 'cell', boc: stateHeader(cells) },
      });
    }
    for (const oversized of [
      stateHeader(2 ** 16 + 1),
      stateHeader(1) + 'A'.repeat(2 ** 24 - 16 + 1),
    ]) {
      stack = withContent(oversized);
      expect(await t.run(t.api.jettonData(MASTER, READ))).toEqual({
        exitCode: 0,
        content: { kind: 'oversized' },
      });
    }
    // Not a TEP-74 master: no content.
    for (const other of [[['num', '0x1']], [0, 0, 0, ['num', '0x1']]]) {
      stack = other;
      expect(await t.run(t.api.jettonData(MASTER, READ))).toEqual({ exitCode: 0 });
    }
    for (const refused of [withContent('not a BOC'), withContent(''), [0, 0, 0, 'x']]) {
      stack = refused;
      await expect(t.run(t.api.jettonData(MASTER, READ))).rejects.toMatchObject(
        malformedAnswer,
      );
    }
  });

  it('reads indexed token metadata only once indexed and valid; decimals from extra', async () => {
    const t = tonNode();
    let entry: unknown = {};
    t.node.intercept = (_endpoint, route) =>
      route === '/metadata' ? { json: { [MASTER.toUpperCase()]: entry } } : undefined;
    const usdt = {
      valid: true,
      type: 'jetton_masters',
      symbol: 'USD₮',
      name: 'Tether USD',
      extra: { decimals: '6', uri: 'https://tether.to/usdt-ton.json' },
    };
    entry = { is_indexed: true, token_info: [usdt] };
    expect(await t.run(t.api.tokenInfo(MASTER, READ))).toEqual({
      symbol: 'USD₮',
      decimals: '6',
      name: 'Tether USD',
    });
    // None yet: not indexed, nothing valid, only another kind of token.
    const none: unknown[] = [
      { is_indexed: false, token_info: [usdt] },
      { is_indexed: true, token_info: [] },
      { is_indexed: true, token_info: [{ ...usdt, valid: false }] },
      { is_indexed: true, token_info: [{ ...usdt, type: 'nft_collections' }] },
    ];
    for (const item of none) {
      entry = item;
      await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toBeUndefined();
    }
    // A name over its limit is left out; decimals may be written as a number.
    entry = {
      token_info: [
        { valid: true, symbol: 'S', name: 'N'.repeat(257), extra: { decimals: 9 } },
      ],
    };
    expect(await t.run(t.api.tokenInfo(MASTER, READ))).toEqual({
      symbol: 'S',
      decimals: '9',
    });
    // Decimals or a symbol that are not one are the token's own data, which every
    // endpoint agrees on: reported unreadable (null), for the caller to judge only if it
    // needs that field; never malformed, which would retry the token forever.
    for (const extra of [
      { decimals: '256' },
      { decimals: -1 },
      { decimals: 'six' },
      { decimals: true },
      'x',
    ]) {
      entry = { is_indexed: true, token_info: [{ ...usdt, extra }] };
      await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toEqual({
        symbol: 'USD₮',
        decimals: null,
        name: 'Tether USD',
      });
    }
    entry = { is_indexed: true, token_info: [{ ...usdt, symbol: ['USD₮'] }] };
    await expect(t.run(t.api.tokenInfo(MASTER, READ))).resolves.toEqual({
      symbol: null,
      decimals: '6',
      name: 'Tether USD',
    });
    // The answer's own structure is still the indexer's: malformed, retryable.
    for (const broken of [
      { is_indexed: 'yes', token_info: [usdt] },
      { is_indexed: true, token_info: 'x' },
      { is_indexed: true, token_info: [7] },
    ]) {
      entry = broken;
      await expect(t.run(t.api.tokenInfo(MASTER, READ))).rejects.toMatchObject(
        malformedAnswer,
      );
    }
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

  it('waits on no real timer', async () => {
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

// "Not included" rests only on these reads: the wallet's raw liteserver transactions,
// each hashed locally and hash-linked back from an account state bound to an attested
// block. An indexer is a positive hint only.
describe('the toncenter API layer: authenticated chain reads', () => {
  /** Where `match` holds, the node's own answer as `edit` makes it (read past the intercept). */
  function rewrite(
    t: ReturnType<typeof tonNode>,
    route: string,
    edit: (json: Json) => unknown,
  ): void {
    let inner = false;
    t.node.intercept = (_endpoint, served, request) => {
      if (inner || served !== route) return undefined;
      inner = true;
      return (async () => {
        try {
          const response = await t.node.fetch.fetch(request.url.href, {
            method: request.method,
            ...(request.body !== undefined ? { body: request.body } : {}),
          });
          return { json: edit((await response.json()) as Json) };
        } finally {
          inner = false;
        }
      })();
    };
  }

  it('binds a state and a get-method to the block and state they were read at', async () => {
    const t = tonNode();
    const { wallet } = await withTransfer(t);
    const head = await t.run(t.api.masterchainHead(MONITOR));
    const header = await t.run(t.api.masterchainHeader(head, PROOF));
    const state = await t.run(t.api.account(wallet, PROOF, head));
    expect(state.block).toEqual(header.id);
    const [deploy] = t.node.transactions();
    expect(state).toMatchObject({ lastLt: deploy!.lt, lastHash: deploy!.hash });
    const bound = await t.run(t.api.runGetMethodAt(wallet, 'seqno', [], PROOF, head));
    expect(bound).toEqual({
      exitCode: 0,
      stack: [{ type: 'num', value: 1n }],
      block: header.id,
      lastTransaction: { lt: deploy!.lt, hash: deploy!.hash },
    });
    // The parser a caller's quorum key reads is the same one.
    const answer = await t.run(
      t.rpc.http<unknown>({
        method: 'POST',
        path: '/runGetMethod',
        body: { address: wallet, method: 'seqno', stack: [], seqno: head },
      }),
    );
    expect(boundRunResultOf(answer)).toEqual(bound);
    // An answer that names no block or no last transaction binds nothing: malformed.
    for (const field of ['block_id', 'last_transaction_id']) {
      rewrite(t, '/runGetMethod', (json) => {
        const { [field]: _dropped, ...result } = json.result as Json;
        return { ...json, result };
      });
      await expect(
        t.run(t.api.runGetMethodAt(wallet, 'seqno', [], READ, head)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
  });

  it('reads raw transactions with their cells, capped before decoding', async () => {
    const t = tonNode();
    const { wallet } = await withTransfer(t);
    const state = await t.run(t.api.account(wallet, READ));
    const from = { lt: state.lastLt, hash: state.lastHash };
    const queries: URLSearchParams[] = [];
    t.node.intercept = (_endpoint, route, request) => {
      if (route === '/getTransactions') queries.push(request.url.searchParams);
      return undefined;
    };
    const [row] = await t.run(t.api.rawTransactions(wallet, from, 4, PROOF));
    // A walk may reach old history, which only archive liteservers hold.
    expect(queries.map((q) => q.get('archival'))).toEqual(['true']);
    t.node.intercept = undefined;
    const [deploy] = t.node.transactions();
    expect(row).toEqual({
      lt: deploy!.lt,
      hash: deploy!.hash,
      boc: deploy!.raw.toBoc().toString('base64'),
    });
    const refused = async (edit: (rows: Json[]) => unknown) => {
      rewrite(t, '/getTransactions', (json) => ({
        ...json,
        result: edit(json.result as Json[]),
      }));
      await expect(
        t.run(t.api.rawTransactions(wallet, from, 1, READ)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    };
    // More rows than asked, a row without its id or cell, a cell past an account's limits.
    await refused((rows) => [...rows, ...rows]);
    await refused((rows) => rows.map(({ transaction_id: _id, ...rest }) => rest));
    await refused((rows) => rows.map(({ data: _data, ...rest }) => rest));
    // A header (size 4 bytes) claiming 2^20 cells, beyond an account state's 2^16.
    const oversized = Buffer.from([
      0xb5, 0xee, 0x9c, 0x72, 0x04, 0x01, 0, 0x10, 0, 0, 0, 1,
    ]);
    await refused((rows) =>
      rows.map((r) => ({ ...r, data: oversized.toString('base64') })),
    );
    await refused((rows) => rows.map((r) => ({ ...r, data: 'A'.repeat(100_000) })));
    t.node.intercept = undefined;
    // A non-raw address is refused before any request.
    const served = t.node.served.length;
    await expect(
      t.run(t.api.rawTransactions(FRIENDLY, from, 1, PROOF)),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(t.node.served).toHaveLength(served);
  });

  it("reads the chain's account statuses on v3 transactions, and nothing else for them", async () => {
    const t = tonNode();
    const { wallet } = await withTransfer(t);
    const [deploy] = await t.run(t.api.accountTransactions(wallet, { limit: 1 }, READ));
    expect(deploy).toMatchObject({ origStatus: 'uninit', endStatus: 'active' });
    rewrite(t, '/transactions', (json) => ({
      ...json,
      transactions: (json.transactions as Json[]).map(
        ({ orig_status: _o, end_status: _e, ...tx }) => tx,
      ),
    }));
    const [bare] = await t.run(t.api.accountTransactions(wallet, { limit: 1 }, READ));
    expect(bare?.origStatus).toBeUndefined();
    expect(bare?.endStatus).toBeUndefined();
    rewrite(t, '/transactions', (json) => ({
      ...json,
      transactions: (json.transactions as Json[]).map((tx) => ({
        ...tx,
        end_status: 'deleted',
      })),
    }));
    await expect(
      t.run(t.api.accountTransactions(wallet, { limit: 1 }, READ)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('attests that the indexer reached a block with a predicate', async () => {
    const t = tonNode({ indexerLag: 2 }, ['a', 'b']);
    t.node.mine(5);
    expect(await t.run(t.api.indexerReached(t.node.head - 2, PROOF))).toBe(true);
    expect(await t.run(t.api.indexerReached(t.node.head, PROOF))).toBe(false);
  });
});
