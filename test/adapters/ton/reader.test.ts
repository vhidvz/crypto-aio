import { ed25519 } from '@noble/curves/ed25519';
import {
  Cell,
  Dictionary,
  beginCell,
  external,
  storeMessage,
  storeMessageRelaxed,
  type MessageRelaxed,
} from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { createHash } from 'node:crypto';
import { READ } from '../../../src/adapters/ton/api';
import {
  OP,
  addressArgument as addressArgumentOf,
  jettonMessage,
  nativeMessage,
} from '../../../src/adapters/ton/messages';
import { REASONS, consumesSeqno } from '../../../src/adapters/ton/trace';
import { normalizedHash, sdkAddress } from '../../../src/adapters/ton/wallets';
import type { AttemptRef } from '../../../src/core/model/transaction';
import type { OrderingData } from '../../../src/core/model/ordering';
import type { FakeRequest } from '../../../src/testing/fake-fetch';
import { tonHarness } from './support/context';
import { relayedBody, signedBoc, testWallet } from './support/harness';
import { KEY, PUBLIC_KEY, TEST_WALLETS, USDT_MASTER } from './support/vectors';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const FRESH = `0:${'11'.repeat(32)}`;
const MASTER = `0:${'77'.repeat(32)}`;
const ORDERING: OrderingData = { kind: 'seqno', seqno: 0n, validUntil: 0 };
const ref = (id: string): AttemptRef => ({
  id,
  idKind: 'message-hash',
  canonical: false,
});

async function pay(h: ReturnType<typeof tonHarness>, bounce: boolean, funds = 3n * GRAM) {
  const wallet = testWallet('v4r2', TESTNET);
  h.node.fund(wallet, funds);
  const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
    seqno: 0,
    validUntil: Math.floor(h.clock.now() / 1000) + 60,
    deploy: true,
    messages: [nativeMessage({ to: FRESH, value: GRAM, bounce, memo: 'invoice 7' })],
  });
  h.node.submit(boc);
  return { wallet, hashNorm };
}

describe('TON address codec wiring', () => {
  it('derives each wallet from the network global id, and refuses a missing identity', () => {
    const h = tonHarness();
    const key = Buffer.from(PUBLIC_KEY, 'hex');
    expect(h.ctx.codec.fromPublicKey(key, { ton: { version: 'v5r1' } }).canonical).toBe(
      TEST_WALLETS.v5r1.testnet,
    );
    expect(() => h.ctx.codec.fromPublicKey(key, {})).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() =>
      h.ctx.codec.fromPublicKey(key, { ton: { version: 'v5r1', networkGlobalId: -239 } }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(h.ctx.codec.normalize(USDT_MASTER.testBounceable).canonical).toBe(
      USDT_MASTER.raw,
    );
  });
});

describe('the TON reader', () => {
  it('reads native and jetton balances; an undeployed jetton wallet holds 0', async () => {
    const h = tonHarness();
    const owner = testWallet('v4r2', TESTNET);
    h.node.fund(owner, 5n);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, owner, 42n);
    const jetton = { standard: 'jetton', contract: MASTER };
    expect(await h.run(h.reader.getBalance(owner, 'native'))).toBe(5n);
    expect(await h.run(h.reader.getBalance(owner, jetton))).toBe(42n);
    expect(await h.run(h.reader.getBalance(FRESH, jetton))).toBe(0n);
    expect(await h.run(h.ext.ton.jettonWallet(owner, MASTER))).toBe(
      h.node.jettonWalletOf(MASTER, owner),
    );
    await expect(
      h.run(h.reader.getBalance(owner, { standard: 'jetton', contract: FRESH })),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    await expect(
      h.run(h.reader.getBalance(owner, { standard: 'erc20', contract: MASTER })),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
  });

  it('reads heights and masterchain blocks by height and by hash', async () => {
    const h = tonHarness();
    h.node.mine(3);
    const head = BigInt(h.node.head);
    expect(await h.run(h.reader.getBlockHeight())).toBe(head);
    expect(await h.run(h.reader.getFinalizedHeight())).toBe(head);
    const block = await h.run(h.reader.getBlock(head));
    expect(block).toEqual({
      height: head,
      hash: h.node.block(Number(head))?.rootHash,
      parentHash: h.node.block(Number(head) - 1)?.rootHash,
      timestamp: h.node.block(Number(head))?.genUtime,
    });
    expect(await h.run(h.reader.getBlock(block!.hash))).toEqual(block);
    expect(await h.run(h.reader.getBlock(head + 1n))).toBeNull();
    expect(await h.run(h.reader.getBlock('ab'.repeat(32)))).toBeNull();
  });

  it('finds a transaction by its message hash or its own hash', async () => {
    const h = tonHarness();
    const { wallet, hashNorm } = await pay(h, false);
    h.node.mine(2);
    const byMessage = await h.run(h.reader.getTransaction(hashNorm));
    expect(byMessage).toMatchObject({
      observation: { seen: 'block', success: true },
      transfers: [{ locator: 'msg:0', from: [wallet], to: FRESH, amount: GRAM }],
    });
    const byHash = await h.run(h.reader.getTransaction(byMessage!.id));
    expect(byHash?.id).toBe(byMessage?.id);
    expect(await h.run(h.reader.getTransaction('cd'.repeat(32)))).toBeNull();
    expect(await h.run(h.reader.getTransaction('not-a-hash'))).toBeNull();
  });

  it('observes an Attempt: absent, included pending its trace, then its verdict', async () => {
    const h = tonHarness();
    const { hashNorm } = await pay(h, false);
    const from = testWallet('v4r2', TESTNET);
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, from))).toEqual({
      seen: 'none',
    });
    h.node.mine();
    const pending = await h.run(h.reader.observe(ref(hashNorm), ORDERING, from));
    expect(pending).toMatchObject({ seen: 'block', blockHeight: 2n });
    expect(pending.success).toBeUndefined();
    expect(pending.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.blockHash).toBe(h.node.block(2)?.rootHash);
    h.node.mine();
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, from))).toMatchObject({
      success: true,
    });
  });

  it('observes a bounced or skipped Attempt as failed with a fixed reason (P6-2)', async () => {
    const bounced = tonHarness();
    const b = await pay(bounced, true);
    bounced.node.mine(3);
    expect(
      await bounced.run(bounced.reader.observe(ref(b.hashNorm), ORDERING, b.wallet)),
    ).toMatchObject({ seen: 'block', success: false, reason: REASONS.bounced });
    const skipped = tonHarness();
    const s = await pay(skipped, false, GRAM / 10n);
    skipped.node.mine();
    expect(
      await skipped.run(skipped.reader.observe(ref(s.hashNorm), ORDERING, s.wallet)),
    ).toMatchObject({ success: false, reason: REASONS.skipped });
  });

  it('reports an unmanaged lookup as the chain does (lesson 15)', async () => {
    const h = tonHarness();
    const { hashNorm } = await pay(h, true);
    h.node.mine(3);
    const tx = await h.run(h.reader.getTransaction(hashNorm));
    // The wallet transaction itself executed; the bounce is its recipient's story.
    expect(
      await h.run(
        h.reader.observe(
          { id: tx!.id, idKind: 'tx-hash', canonical: true },
          undefined,
          undefined,
        ),
      ),
    ).toMatchObject({ seen: 'block', success: true });
  });

  it('decodes a jetton deposit only from a jetton wallet its master names (D14)', async () => {
    const h = tonHarness();
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
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
          memo: 'order 9',
        }),
      ],
    });
    h.node.submit(boc);
    // An impostor claims the master and notifies FRESH of a million tokens.
    const impostor = `0:${'66'.repeat(32)}`;
    h.node.deployFakeJettonWallet(impostor, MASTER, FRESH, 1_000_000n);
    h.node.inject(
      impostor,
      FRESH,
      1n,
      beginCell()
        .storeUint(OP.jettonNotification, 32)
        .storeUint(0, 64)
        .storeCoins(1_000_000n)
        .storeAddress(sdkAddress(sender))
        .storeBit(false)
        .endCell(),
    );
    h.node.mine(5);
    const history = await h.run(
      h.ctx.api.accountTransactions(FRESH, { limit: 10 }, READ),
    );
    const decoded = await Promise.all(
      history.map((tx) => h.run(h.reader.getTransaction(tx.hash))),
    );
    const tokens = decoded.flatMap(
      (tx) => tx?.transfers.filter((x) => x.source === 'token-event') ?? [],
    );
    expect(tokens).toEqual([
      expect.objectContaining({
        to: FRESH,
        from: [sender],
        asset: { standard: 'jetton', contract: MASTER },
        amount: 400n,
        memo: 'order 9',
      }),
    ]);
    expect(decoded.some((tx) => tx?.decoding === 'partial')).toBe(true);
  });

  it('reads jetton metadata on chain, then from the indexer, per lesson 13', async () => {
    const h = tonHarness();
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const off = `0:${'78'.repeat(32)}`;
    h.node.deployJetton(off, { symbol: 'OFF', decimals: 2, content: 'offchain' });
    const bare = `0:${'79'.repeat(32)}`;
    h.node.deployJetton(bare, { content: 'onchain' });
    const jetton = (contract: string) => ({ standard: 'jetton', contract });
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
    });
    expect(await h.run(h.reader.getTokenMetadata!(jetton(off)))).toEqual({
      symbol: 'OFF',
      decimals: 2,
    });
    await expect(h.run(h.reader.getTokenMetadata!(jetton(bare)))).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      message: 'the jetton has no symbol',
    });
    await expect(h.run(h.reader.getTokenMetadata!(jetton(FRESH)))).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
    });
    h.node.intercept = (_e, route) =>
      route === '/runGetMethod'
        ? { status: 422, json: { ok: false, error: 'x', code: 422 } }
        : undefined;
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'RPC_ERROR',
        retryable: true,
      },
    );
    h.node.intercept = (_e, route) =>
      route === '/runGetMethod'
        ? { status: 401, json: { ok: false, error: 'bad key', code: 401 } }
        : undefined;
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'PROVIDER_MISCONFIGURED',
      },
    );
    expect(h.reader.normalizeTokenRef!(jetton(USDT_MASTER.bounceable))).toEqual(
      jetton(USDT_MASTER.raw),
    );
  });

  it('reads seqnos: 0 undeployed, the stored seqno once deployed', async () => {
    const h = tonHarness();
    const wallet = testWallet('v4r2', TESTNET);
    expect(await h.run(h.sequence.pending(wallet))).toBe(0n);
    h.node.deployWallet(wallet, {
      version: 'v4r2',
      publicKey: Buffer.from(PUBLIC_KEY, 'hex'),
      walletId: 698983191,
      seqno: 12,
    });
    expect(await h.run(h.sequence.pending(wallet))).toBe(12n);
    expect(await h.run(h.ext.ton.getSeqno(wallet))).toBe(12n);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    await expect(h.run(h.sequence.pending(MASTER))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });

  it('tags reads as read and observations as monitor (R41)', async () => {
    const h = tonHarness();
    const seen: string[] = [];
    const original = h.rpc.http.bind(h.rpc);
    h.rpc.http = ((request, options) => {
      seen.push(`${request.route}:${options?.purpose}`);
      return original(request, options);
    }) as typeof h.rpc.http;
    await h.run(h.reader.getBalance(FRESH, 'native'));
    await h.run(h.reader.getBlockHeight());
    await h.run(h.sequence.pending(FRESH));
    expect(seen).toEqual([
      '/getAddressInformation:read',
      '/getMasterchainInfo:monitor',
      '/getAddressInformation:monitor',
    ]);
  });
});

describe('the TON reader: review fixes', () => {
  it('floors the next seqno at the indexer once the previous transfer is included (I1)', async () => {
    const h = tonHarness();
    const { hashNorm } = await pay(h, false);
    h.node.mine(3);
    const from = testWallet('v4r2', TESTNET);
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, from))).toMatchObject({
      seen: 'block',
    });
    // The liteserver behind the rpc URL lags to before the deploy: the wallet has no key
    // there to check the indexed request against, and the evidence's own block is not
    // served yet, so `pending` decides nothing rather than guess (retryable).
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.latest(from))).toBe(0n);
    await expect(h.run(h.sequence.pending(from))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // Deployed: the next transfer (seqno 1) lands, and a lagging read still shows seqno 1.
    h.node.lagEndpoint('main', 0);
    const next = await signedBoc('v4r2', TESTNET, {
      seqno: 1,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: false,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(next.boc);
    h.node.mine(3);
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.latest(from))).toBe(1n);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
    h.node.lagEndpoint('main', 0);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
  });

  it('binds the live seqno and the public key to the block and the state they were read at (F6-R29 Q6)', async () => {
    const h = tonHarness();
    const from = testWallet('v4r2', TESTNET);
    h.node.fund(from, 3n * GRAM);
    const deploy = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(deploy.boc);
    h.node.mine(3);
    const next = await signedBoc('v4r2', TESTNET, {
      seqno: 1,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: false,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(next.boc);
    h.node.mine(3);
    // The live read lags behind the second request: the floor reads the key at its block.
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.latest(from))).toBe(1n);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
    const shifted = (edit: (result: Json) => Json) => (json: Json) => ({
      ...json,
      result: edit(json.result as Json),
    });
    const otherBlock = (result: Json) => ({
      ...result,
      block_id: {
        ...(result.block_id as Json),
        seqno: ((result.block_id as Json).seqno as number) - 1,
      },
    });
    const otherState = (result: Json) => ({
      ...result,
      last_transaction_id: { ...(result.last_transaction_id as Json), lt: '1' },
    });
    for (const [method, edit] of [
      ['seqno', otherBlock],
      ['seqno', otherState],
      ['get_public_key', otherBlock],
      ['get_public_key', otherState],
    ] as const) {
      rewrite(
        h,
        (_e, route, request) => getMethod(route, request, method),
        shifted(edit),
      );
      const read =
        method === 'seqno' ? h.sequence.latest(from) : h.sequence.pending(from);
      await expect(h.run(read)).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    h.node.intercept = undefined;
    expect(await h.run(h.ext.ton.getSeqno(from))).toBe(1n);
  });

  it('never takes a request the chain could not have run for the seqno floor: it had expired (Task 10 concern 3)', async () => {
    const h = tonHarness();
    const from = testWallet('v4r2', TESTNET);
    h.node.fund(from, 3n * GRAM);
    const deploy = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(deploy.boc);
    h.node.mine(3);
    const validUntil = Math.floor(h.clock.now() / 1000) + 60;
    const next = await signedBoc('v4r2', TESTNET, {
      seqno: 1,
      validUntil,
      deploy: false,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(next.boc);
    h.node.mine(3);
    // The live read lags behind the second request: the floor reads it from the indexer.
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
    // A lone indexer dates the genuine request after its own lifetime: no chain runs that.
    rewrite(
      h,
      (_e, route, request) =>
        route === '/transactions' && request.url.searchParams.has('account'),
      (json) => ({
        ...json,
        transactions: (json.transactions as Json[]).map((tx) => ({
          ...tx,
          now: validUntil + 10,
        })),
      }),
    );
    await expect(h.run(h.sequence.pending(from))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('raises the floor only for proven requests newer than the live read (A23)', async () => {
    const h = tonHarness();
    const from = testWallet('v5r1', TESTNET);
    const relayer = `0:${'22'.repeat(32)}`;
    const now = () => Math.floor(h.clock.now() / 1000);
    h.node.fund(from, 3n * GRAM);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(boc);
    h.node.mine(4);
    const relayed = (seqno: number, seed?: string) =>
      relayedBody(TESTNET, {
        seqno,
        validUntil: now() + 60,
        messages: [nativeMessage({ to: FRESH, value: 2n, bounce: false })],
        ...(seed !== undefined ? { seed } : {}),
      });
    // A forged relayed request claiming seqno 5: the wallet ignores it, and so does the floor.
    h.node.inject(relayer, from, 50_000_000n, relayed(5, 'ab'.repeat(32)));
    h.node.mine(3);
    h.node.lagEndpoint('main', 3); // the live read predates the forged transaction
    expect(await h.run(h.sequence.latest(from))).toBe(1n);
    expect(await h.run(h.sequence.pending(from))).toBe(1n);
    // The owner's genuine relayed request for seqno 1 runs and counts.
    h.node.lagEndpoint('main', 0);
    h.node.inject(relayer, from, 50_000_000n, relayed(1));
    h.node.mine(3);
    expect(h.node.seqno(from)).toBe(2);
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.latest(from))).toBe(1n);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
    // Once the live read has caught up, it decides alone.
    h.node.lagEndpoint('main', 0);
    expect(await h.run(h.sequence.pending(from))).toBe(2n);
  });

  it('fails a jetton verdict whose recipient wallet the master does not name (I5)', async () => {
    const h = tonHarness();
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
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
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, sender))).toMatchObject({
      success: true,
    });
    // The master now names another wallet for FRESH: the arrival is not the master's.
    h.node.intercept = (_e, route, request) =>
      route === '/runGetMethod' &&
      request.json<{ method: string; stack: [string, string][] }>().method ===
        'get_wallet_address' &&
      request.json<{ address: string }>().address === MASTER &&
      request.json<{ stack: [string, string][] }>().stack[0]?.[1] !== undefined &&
      !request.body?.includes(addressArgumentOf(sender))
        ? {
            json: {
              ok: true,
              result: {
                exit_code: 0,
                stack: [['cell', { bytes: addressArgumentOf(`0:${'66'.repeat(32)}`) }]],
              },
            },
          }
        : undefined;
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, sender))).toMatchObject({
      success: false,
      reason: REASONS.jettonUnverified,
    });
  });

  it('decides nothing when a jetton leg gives no answer or the sender wallet is not ours (final review I1)', async () => {
    const h = tonHarness();
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
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
    const answer = (wallet: string, result: Record<string, unknown>) => {
      h.node.intercept = (_e, route, request) =>
        route === '/runGetMethod' &&
        request.json<{ method: string }>().method === 'get_wallet_data' &&
        request.json<{ address: string }>().address === wallet
          ? { json: { ok: true, result } }
          : undefined;
    };
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      // "No state at this block" for either wallet, or any other exit code.
      [h.node.jettonWalletOf(MASTER, FRESH), { exit_code: -13, stack: [] }],
      [h.node.jettonWalletOf(MASTER, sender), { exit_code: -13, stack: [] }],
      [h.node.jettonWalletOf(MASTER, FRESH), { exit_code: 11, stack: [] }],
      // Our own jetton wallet named for another owner: it contradicts the attested build.
      [
        h.node.jettonWalletOf(MASTER, sender),
        {
          exit_code: 0,
          stack: [
            ['num', '0x190'],
            ['cell', { bytes: addressArgumentOf(FRESH) }],
            ['cell', { bytes: addressArgumentOf(MASTER) }],
            ['cell', { bytes: addressArgumentOf(MASTER) }],
          ],
        },
      ],
    ];
    for (const [wallet, result] of cases) {
      answer(wallet, result);
      await expect(
        h.run(h.reader.observe(ref(hashNorm), ORDERING, sender)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    }
    // Our jetton wallet verified as the master's for another owner: it contradicts the
    // attested build just the same.
    const ours = h.node.jettonWalletOf(MASTER, sender);
    h.node.intercept = (_e, route, request) => {
      if (route !== '/runGetMethod') return undefined;
      const body = request.json<{ method: string; address: string }>();
      if (body.method === 'get_wallet_data' && body.address === ours) {
        return {
          json: {
            ok: true,
            result: {
              exit_code: 0,
              stack: [
                ['num', '0x190'],
                ['cell', { bytes: addressArgumentOf(FRESH) }],
                ['cell', { bytes: addressArgumentOf(MASTER) }],
                ['cell', { bytes: addressArgumentOf(MASTER) }],
              ],
            },
          },
        };
      }
      return body.method === 'get_wallet_address' &&
        body.address === MASTER &&
        request.body?.includes(addressArgumentOf(FRESH))
        ? {
            json: {
              ok: true,
              result: {
                exit_code: 0,
                stack: [['cell', { bytes: addressArgumentOf(ours) }]],
              },
            },
          }
        : undefined;
    };
    await expect(
      h.run(h.reader.observe(ref(hashNorm), ORDERING, sender)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    h.node.intercept = undefined;
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, sender))).toMatchObject({
      success: true,
    });
  });

  it('reports a non-bounceable value a failing contract kept as executed (M7)', async () => {
    const h = tonHarness();
    const reverter = `0:${'55'.repeat(32)}`;
    h.node.deployReverter(reverter);
    const wallet = testWallet('v4r2', TESTNET);
    h.node.fund(wallet, 2n * GRAM);
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: true,
      messages: [nativeMessage({ to: reverter, value: GRAM, bounce: false })],
    });
    h.node.submit(boc);
    h.node.mine(3);
    const root = await h.run(h.reader.getTransaction(hashNorm));
    const kept = (
      await h.run(h.ctx.api.accountTransactions(reverter, { limit: 1 }, READ))
    )[0]!;
    expect(kept).toMatchObject({ aborted: true, compute: { success: false } });
    expect((await h.run(h.reader.getTransaction(kept.hash)))?.observation.success).toBe(
      true,
    );
    expect(root?.observation.success).toBe(true);
  });

  it("treats an unparseable jetton content BOC as the endpoint's fault (M6)", async () => {
    const h = tonHarness();
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.intercept = (_e, route) =>
      route === '/runGetMethod'
        ? {
            json: {
              ok: true,
              result: {
                exit_code: 0,
                stack: [
                  ['num', '0x1'],
                  ['num', '-0x1'],
                  ['cell', { bytes: 'AAAA' }],
                  ['cell', { bytes: 'not a boc' }],
                  ['cell', { bytes: 'AAAA' }],
                ],
              },
            },
          }
        : undefined;
    await expect(
      h.run(h.reader.getTokenMetadata!({ standard: 'jetton', contract: MASTER })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });
});

// ---- carries from the Task 3–7 reviews, and F6-R12 --------------------------------------

type Harness = ReturnType<typeof tonHarness>;
type Json = Record<string, unknown>;

const jetton = (contract: string) => ({ standard: 'jetton', contract });

/**
 * A v4r2 request from the test key's wallet with each message's own send mode: our builder
 * always sends mode 3, a foreign request signed with the same key need not.
 */
function v4Request(
  h: Harness,
  seqno: number,
  messages: readonly (readonly [number, MessageRelaxed])[],
): { readonly boc: string; readonly hashNorm: string } {
  const contract = WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(PUBLIC_KEY, 'hex'),
  });
  const signing = beginCell()
    .storeUint(contract.walletId, 32)
    .storeUint(Math.floor(h.clock.now() / 1000) + 60, 32)
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

/** Where `match` holds, the node's own answer (read past this intercept) as `edit` makes it. */
function rewrite(
  h: Harness,
  match: (endpoint: string, route: string, request: FakeRequest) => boolean,
  edit: (json: Json) => Json,
): void {
  let inner = false;
  h.node.intercept = (endpoint, route, request) => {
    if (inner || !match(endpoint, route, request)) return undefined;
    inner = true;
    return (async () => {
      try {
        const response = await h.node.fetch.fetch(request.url.href, {
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
        return { status: response.status, json: edit((await response.json()) as Json) };
      } finally {
        inner = false;
      }
    })();
  };
}

const getMethod = (route: string, request: FakeRequest, method: string): boolean =>
  route === '/runGetMethod' && request.json<{ method: string }>().method === method;

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();
const EMPTY_CELL = beginCell().endCell().toBoc().toString('base64');
/** A TEP-64 snake value: prefix 0x00, then the text. */
const snake = (text: string): Cell =>
  beginCell().storeUint(0, 8).storeStringTail(text).endCell();

/** Snake data of `cells` cells, `bytes` bytes ('A') each, prefixed 0x00. */
function snakeChain(cells: number, bytes: number): Cell {
  let tail: Cell | undefined;
  for (let i = cells - 1; i >= 0; i--) {
    const cell = beginCell();
    if (i === 0) cell.storeUint(0, 8);
    cell.storeBuffer(Buffer.alloc(bytes, 0x41));
    if (tail) cell.storeRef(tail);
    tail = cell.endCell();
  }
  return tail as Cell;
}

/** TEP-64 on-chain content (base64 BOC): a dictionary of sha256(key) → value cell. */
function onchainContent(values: Readonly<Record<string, Cell>>): string {
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  for (const [key, value] of Object.entries(values)) dict.set(sha(key), value);
  return beginCell().storeUint(0, 8).storeDict(dict).endCell().toBoc().toString('base64');
}

/** A `get_jetton_data` answer holding `content` (base64 BOC). */
const jettonDataReply = (content: string) => ({
  json: {
    ok: true,
    result: {
      exit_code: 0,
      stack: [
        ['num', '0x1'],
        ['num', '-0x1'],
        ['cell', { bytes: EMPTY_CELL }],
        ['cell', { bytes: content }],
        ['cell', { bytes: EMPTY_CELL }],
      ],
    },
  },
});

/** Every endpoint's `get_jetton_data` answers with `content`. */
function withContent(h: Harness, content: string): void {
  h.node.intercept = (_e, route, request) =>
    getMethod(route, request, 'get_jetton_data') ? jettonDataReply(content) : undefined;
}

/** A BOC header (magic b5ee9c72, 3-byte counts) declaring `cells` cells. */
function bocHeader(cells: number): string {
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

/** TEP-64 chunked data (`chunks#01`): each part a chunk cell under its index. */
function chunked(parts: readonly (string | Cell)[], keys = parts.map((_, i) => i)): Cell {
  const dict = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
  parts.forEach((part, i) =>
    dict.set(
      keys[i] as number,
      typeof part === 'string'
        ? beginCell().storeBuffer(Buffer.from(part)).endCell()
        : part,
    ),
  );
  return beginCell().storeUint(1, 8).storeDict(dict).endCell();
}

/** `n` distinct cells as a tree (up to 4 refs each, so its depth stays small). */
function cellTree(n: number): Cell {
  const built: Cell[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const cell = beginCell().storeUint(i, 32);
    for (let k = 1; k <= 4 && 4 * i + k < n; k++) cell.storeRef(built[4 * i + k] as Cell);
    built[i] = cell.endCell();
  }
  return built[0] as Cell;
}

/** Off-chain content (TEP-64 `offchain#01`): the JSON's uri. */
const OFFCHAIN = beginCell()
  .storeUint(1, 8)
  .storeStringTail('https://jetton.test/meta.json')
  .endCell()
  .toBoc()
  .toString('base64');

/** A `/metadata` answer for MASTER holding one valid jetton entry. */
const metadataReply = (token: Json) => ({
  json: {
    [MASTER.toUpperCase()]: {
      is_indexed: true,
      token_info: [{ valid: true, type: 'jetton_masters', ...token }],
    },
  },
});

describe('the TON reader: carries from the Task 3–7 reviews and F6-R12', () => {
  it('observes the run that consumed the seqno when a request ran twice (C8-1)', async () => {
    const h = tonHarness();
    const wallet = testWallet('v4r2', TESTNET);
    // Send mode 1, without +2: a message the balance cannot pay fails the action phase,
    // which drops the seqno the run committed, so the same message may run again.
    const { boc, hashNorm } = v4Request(h, 0, [
      [1, nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    ]);
    h.node.fund(wallet, GRAM / 10n);
    h.node.submit(boc);
    h.node.mine(2);
    const first = await h.run(h.reader.observe(ref(hashNorm), ORDERING, wallet));
    expect(first).toMatchObject({ seen: 'block' });
    expect(first.success).toBeUndefined();
    h.node.fund(wallet, 3n * GRAM);
    h.node.submit(boc);
    h.node.mine(3);
    const runs = await h.run(h.ctx.api.transactionsByMessage(hashNorm, READ));
    expect(runs.map(consumesSeqno)).toEqual([false, true]);
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, wallet))).toMatchObject({
      seen: 'block',
      success: true,
      txHash: runs[1]?.hash,
    });
  });

  it('floors the seqno at an external request only when it consumed the seqno (C8-2)', async () => {
    const h = tonHarness();
    const { wallet } = await pay(h, false);
    h.node.mine(3);
    // The same key signs seqno 1 in mode 1 for more than the wallet holds: the action
    // phase fails, and the seqno stays 1.
    const { boc } = v4Request(h, 1, [
      [1, nativeMessage({ to: FRESH, value: 100n * GRAM, bounce: false })],
    ]);
    h.node.submit(boc);
    h.node.mine(3);
    expect(h.node.seqno(wallet)).toBe(1);
    h.node.lagEndpoint('main', 3); // the live read predates the failed run
    expect(await h.run(h.sequence.latest(wallet))).toBe(1n);
    expect(await h.run(h.sequence.pending(wallet))).toBe(1n);
  });

  it('floors the seqno at a relayed W5 request only when the wallet ran it to the end (C8-2)', async () => {
    const h = tonHarness();
    const from = testWallet('v5r1', TESTNET);
    const relayer = `0:${'22'.repeat(32)}`;
    const now = () => Math.floor(h.clock.now() / 1000);
    h.node.fund(from, 3n * GRAM);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(boc);
    h.node.mine(4);
    // The owner's own request, but in mode 1 for more than the wallet holds: the compute
    // phase succeeds, the action phase fails and takes the seqno with it.
    h.node.inject(
      relayer,
      from,
      50_000_000n,
      relayedBody(TESTNET, {
        seqno: 1,
        validUntil: now() + 60,
        messages: [nativeMessage({ to: FRESH, value: 100n * GRAM, bounce: false })],
        sendMode: 1,
      }),
    );
    h.node.mine(3);
    expect(h.node.seqno(from)).toBe(1);
    const [relayed] = await h.run(
      h.ctx.api.accountTransactions(from, { limit: 1 }, READ),
    );
    expect(relayed).toMatchObject({
      compute: { success: true },
      action: { success: false },
    });
    h.node.lagEndpoint('main', 3);
    expect(await h.run(h.sequence.latest(from))).toBe(1n);
    expect(await h.run(h.sequence.pending(from))).toBe(1n);
  });

  it('pages the seqno floor on the page as served, past a transaction not yet final (F6-R12)', async () => {
    const h = tonHarness();
    const { wallet } = await pay(h, false);
    h.node.mine(3);
    const next = await signedBoc('v4r2', TESTNET, {
      seqno: 1,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
      deploy: false,
      messages: [nativeMessage({ to: FRESH, value: 1n, bounce: false })],
    });
    h.node.submit(next.boc);
    h.node.mine();
    // More than a page of deposits lands after the transfer of seqno 1.
    const payer = `0:${'33'.repeat(32)}`;
    for (let i = 0; i < 70; i++) {
      h.node.inject(payer, wallet, 1_000_000n, beginCell().endCell());
    }
    h.node.mine(2);
    // The newest one is not final on the indexer yet: its full page still leads on.
    rewrite(
      h,
      (_e, route, request) =>
        route === '/transactions' &&
        request.url.searchParams.has('account') &&
        !request.url.searchParams.has('end_lt'),
      (json) => {
        const [newest, ...rest] = json.transactions as Json[];
        return { ...json, transactions: [{ ...newest, finality: 'pending' }, ...rest] };
      },
    );
    h.node.lagEndpoint('main', 3); // the live read predates the transfer of seqno 1
    expect(await h.run(h.sequence.latest(wallet))).toBe(1n);
    expect(await h.run(h.sequence.pending(wallet))).toBe(2n);
  });

  it("checks a jetton verdict's wallets at the trace's own block: a lagging endpoint decides nothing", async () => {
    const h = tonHarness();
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
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
    // The endpoint serves the chain from before the recipient's jetton wallet existed.
    h.node.lagEndpoint('main', 3);
    await expect(
      h.run(h.reader.observe(ref(hashNorm), ORDERING, sender)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    h.node.lagEndpoint('main', 0);
    const blocks: [string, number | undefined][] = [];
    h.node.intercept = (_e, route, request) => {
      if (route === '/runGetMethod') {
        const { method, seqno } = request.json<{ method: string; seqno?: number }>();
        blocks.push([method, seqno]);
      }
      return undefined;
    };
    expect(await h.run(h.reader.observe(ref(hashNorm), ORDERING, sender))).toMatchObject({
      success: true,
    });
    // Every get-method ran at the trace's last block, not at the endpoint's head.
    const trace = await h.run(
      h.ctx.api.trace(
        (await h.run(h.ctx.api.transactionsByMessage(hashNorm, READ)))[0]!.hash,
        READ,
      ),
    );
    const last = Math.max(...trace!.transactions.map((tx) => tx.mcSeqno));
    expect(last).toBeLessThan(h.node.head);
    expect(blocks).toEqual([
      ['get_wallet_data', last],
      ['get_wallet_address', last],
      ['get_wallet_data', last],
      ['get_wallet_address', last],
    ]);
  });

  it("decodes a jetton deposit by its wallet at the deposit's own block, whatever came after", async () => {
    const h = tonHarness();
    const sender = testWallet('v4r2', TESTNET);
    h.node.fund(sender, 2n * GRAM);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    h.node.mintJetton(MASTER, sender, 1_000n);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: Math.floor(h.clock.now() / 1000) + 60,
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
    // The recipient's jetton wallet is frozen afterwards (storage debt): the deposit stands.
    h.node.freeze(h.node.jettonWalletOf(MASTER, FRESH));
    h.node.mine();
    const [deposit] = await h.run(
      h.ctx.api.accountTransactions(FRESH, { limit: 1 }, READ),
    );
    expect(
      (await h.run(h.reader.getTransaction(deposit!.hash)))?.transfers,
    ).toContainEqual(
      expect.objectContaining({ source: 'token-event', from: [sender], amount: 400n }),
    );
  });

  it('reads jetton metadata under the proof quorum, keyed on the content alone (M4)', async () => {
    const h = tonHarness({ endpoints: ['a', 'b'] });
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const tags: unknown[] = [];
    const original = h.rpc.http.bind(h.rpc);
    h.rpc.http = ((request, options) => {
      if (request.route === '/runGetMethod') {
        tags.push({ purpose: options?.purpose, quorum: options?.quorum });
      }
      return original(request, options);
    }) as typeof h.rpc.http;
    let stackOf = (stack: unknown[]): unknown[] => stack;
    rewrite(
      h,
      (endpoint, route, request) =>
        endpoint === 'b' && getMethod(route, request, 'get_jetton_data'),
      (json) => {
        const result = json.result as Json;
        return {
          ...json,
          result: { ...result, stack: stackOf(result.stack as unknown[]) },
        };
      },
    );
    // Another total supply (it moves between reads) and the same cell serialized otherwise:
    // one answer all the same.
    stackOf = (stack) => {
      const [, ...rest] = stack;
      const [, , content, code] = rest as [unknown, unknown, [string, Json], unknown];
      const cell = Cell.fromBoc(Buffer.from(content[1].bytes as string, 'base64'))[0]!;
      const reserialized = cell.toBoc({ idx: true, crc32: false }).toString('base64');
      expect(reserialized).not.toBe(content[1].bytes);
      return [['num', '0x2a'], rest[0], rest[1], ['cell', { bytes: reserialized }], code];
    };
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
    });
    expect(tags).toEqual([{ purpose: 'read', quorum: 'proof' }]);
    // Another content (other decimals): the endpoints disagree, and nothing is decided.
    stackOf = (stack) => {
      const next = [...stack];
      next[3] = [
        'cell',
        { bytes: onchainContent({ decimals: snake('9'), symbol: snake('TST') }) },
      ];
      return next;
    };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      },
    );
  });

  it("never defaults an off-chain jetton's decimals, and reads a missing index as unresolved, never cached (F6-R30 (1))", async () => {
    const h = tonHarness({ node: { indexerLag: 2 } });
    h.node.mine(3);
    const off = `0:${'78'.repeat(32)}`;
    h.node.deployJetton(off, { symbol: 'OFF', decimals: 2, content: 'offchain' });
    // Not indexed yet: unresolved (non-retryable, so a history page reads on) under a code
    // the core never caches (not ASSET_RESOLUTION); a later read resolves it.
    await expect(h.run(h.reader.getTokenMetadata!(jetton(off)))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: false,
    });
    h.node.mine(2);
    expect(await h.run(h.reader.getTokenMetadata!(jetton(off)))).toEqual({
      symbol: 'OFF',
      decimals: 2,
    });
    // Indexed, but the indexer states no decimals for it: still never a default of 9.
    const nodecimals = `0:${'79'.repeat(32)}`;
    h.node.deployJetton(nodecimals, { symbol: 'NOD', content: 'offchain' });
    h.node.mine(2);
    await expect(
      h.run(h.reader.getTokenMetadata!(jetton(nodecimals))),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
    // Content wholly on chain says everything itself: TEP-64's default of 9 applies.
    const nine = `0:${'7a'.repeat(32)}`;
    h.node.deployJetton(nine, { symbol: 'NIN', content: 'onchain' });
    expect(await h.run(h.reader.getTokenMetadata!(jetton(nine)))).toEqual({
      symbol: 'NIN',
      decimals: 9,
    });
    // The indexer's copy of the on-chain content is never needed.
    expect(h.node.served.map((s) => s.route)).not.toContain('/jetton/masters');
  });

  it('reads semi-on-chain content: its own fields first, the rest from the indexer (USDT)', async () => {
    const h = tonHarness();
    const content = onchainContent({
      decimals: snake('6'),
      uri: snake('https://jetton.test/usdt.json'),
    });
    let token: Json = {};
    h.node.intercept = (_e, route, request) =>
      getMethod(route, request, 'get_jetton_data')
        ? jettonDataReply(content)
        : route === '/metadata'
          ? {
              json: {
                [MASTER.toUpperCase()]: { is_indexed: true, token_info: [token] },
              },
            }
          : undefined;
    token = {
      valid: true,
      type: 'jetton_masters',
      name: 'Tether USD',
      symbol: 'USD₮',
      extra: { decimals: '9' },
    };
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'USD₮',
      decimals: 6,
      name: 'Tether USD',
    });
    // Fetched and valid, without a symbol: the token's own.
    token = { valid: true, type: 'jetton_masters', name: 'Nameless' };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'ASSET_RESOLUTION',
        message: 'the jetton has no symbol',
      },
    );
    // Not valid (not fetched yet, or refused): unresolved, never cached (F6-R30 (1)).
    token = { valid: false, symbol: 'X' };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: false,
      },
    );
  });

  it("holds on-chain content to its limits: beyond them it is the token's own (lessons 13, 20)", async () => {
    const h = tonHarness();
    const refused = (message: string) =>
      expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject({
        code: 'ASSET_RESOLUTION',
        retryable: false,
        message,
      });
    // More cells than an account state may hold, as every endpoint serves it: never
    // decoded. Past a message's 2^13 cells is still content (a state holds 2^16).
    withContent(h, bocHeader(2 ** 16 + 1));
    await refused('the jetton content is unreadable');
    const big = onchainContent({
      decimals: snake('6'),
      symbol: snake('TST'),
      image_data: cellTree(9000),
    });
    withContent(h, big);
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
    });
    withContent(h, beginCell().storeUint(2, 8).endCell().toBoc().toString('base64'));
    await refused('the jetton content is unreadable');
    // A value is read in one pass, to at most 64 cells: 64 one-byte cells read, 65 do not.
    const tst = { decimals: snake('6'), symbol: snake('TST') };
    withContent(h, onchainContent({ ...tst, symbol: snakeChain(64, 1) }));
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'A'.repeat(64),
      decimals: 6,
    });
    withContent(h, onchainContent({ ...tst, symbol: snakeChain(65, 1) }));
    await refused('the jetton symbol is unreadable');
    withContent(h, onchainContent({ ...tst, symbol: snake('S'.repeat(257)) }));
    await refused('the jetton symbol is unreadable');
    withContent(h, onchainContent({ ...tst, symbol: snake('') }));
    await refused('the jetton has no symbol');
    withContent(h, onchainContent({ ...tst, decimals: snake('256') }));
    await refused('the jetton decimals are unreadable');
    // Chunked data (TEP-64 `chunks#01`): its chunks in index order, at most 64 of them,
    // each one cell of whole bytes without refs, indexed from 0 without a gap.
    withContent(h, onchainContent({ ...tst, symbol: chunked(['TS', 'T']) }));
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
    });
    withContent(
      h,
      onchainContent({ decimals: chunked(['1', '2']), symbol: snake('TST') }),
    );
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 12,
    });
    const letters = (n: number) => Array.from({ length: n }, () => 'A');
    withContent(h, onchainContent({ ...tst, symbol: chunked(letters(64)) }));
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'A'.repeat(64),
      decimals: 6,
    });
    withContent(h, onchainContent({ ...tst, symbol: chunked(letters(65)) }));
    await refused('the jetton symbol is unreadable');
    withContent(h, onchainContent({ ...tst, symbol: chunked(['TS', 'T'], [0, 2]) }));
    await refused('the jetton symbol is unreadable');
    const withRef = beginCell()
      .storeBuffer(Buffer.from('T'))
      .storeRef(snake('x'))
      .endCell();
    withContent(h, onchainContent({ ...tst, symbol: chunked(['TS', withRef]) }));
    await refused('the jetton symbol is unreadable');
    // An unreadable name is left out (lenient); the token still resolves.
    withContent(h, onchainContent({ ...tst, name: snakeChain(30, 100) }));
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
    });
    withContent(h, onchainContent({ ...tst, name: snake('Test token') }));
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 6,
      name: 'Test token',
    });
  });

  it("decides an oversized content the token's own only when the quorum agrees (F6-R13 M3)", async () => {
    const h = tonHarness({ endpoints: ['a', 'b'] });
    const tst = onchainContent({ decimals: snake('6'), symbol: snake('TST') });
    let served: Record<string, string> = {};
    h.node.intercept = (endpoint, route, request) =>
      getMethod(route, request, 'get_jetton_data')
        ? jettonDataReply(served[endpoint] as string)
        : undefined;
    served = { a: bocHeader(2 ** 16 + 1), b: tst };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      },
    );
    served = { a: bocHeader(2 ** 16 + 1), b: bocHeader(2 ** 16 + 1) };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'ASSET_RESOLUTION',
        retryable: false,
        message: 'the jetton content is unreadable',
      },
    );
  });

  it("reads the indexer's metadata under the proof quorum too (F6-R13 M2)", async () => {
    const h = tonHarness({ endpoints: ['a', 'b'] });
    let decimals: Record<string, string> = {};
    h.node.intercept = (endpoint, route, request) =>
      getMethod(route, request, 'get_jetton_data')
        ? jettonDataReply(OFFCHAIN)
        : route === '/metadata'
          ? metadataReply({ symbol: 'OFF', extra: { decimals: decimals[endpoint] } })
          : undefined;
    decimals = { a: '6', b: '9' };
    await expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject(
      {
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      },
    );
    decimals = { a: '6', b: '6' };
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'OFF',
      decimals: 6,
    });
  });

  it("judges the indexer's metadata only by the fields it uses; a bad one is the token's own (F6-R13 M4)", async () => {
    const h = tonHarness();
    let content = OFFCHAIN;
    let token: Json = {};
    h.node.intercept = (_e, route, request) =>
      getMethod(route, request, 'get_jetton_data')
        ? jettonDataReply(content)
        : route === '/metadata'
          ? metadataReply(token)
          : undefined;
    const refused = (message: string) =>
      expect(h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).rejects.toMatchObject({
        code: 'ASSET_RESOLUTION',
        retryable: false,
        message,
      });
    // Off-chain: the indexer's copy decides, and a bad field it needs is the token's own.
    token = { symbol: 'OFF', extra: { decimals: 'six' } };
    await refused('the jetton decimals are unreadable');
    token = { symbol: 7, extra: { decimals: '6' } };
    await refused('the jetton symbol is unreadable');
    // USDT's shape: decimals on chain, so the indexer's are never used or judged.
    content = onchainContent({
      decimals: snake('6'),
      uri: snake('https://x.test/j.json'),
    });
    token = { symbol: 'USD₮', extra: { decimals: 'six' } };
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'USD₮',
      decimals: 6,
    });
    // A symbol on chain: the indexer's is never used or judged.
    content = onchainContent({
      symbol: snake('TST'),
      uri: snake('https://x.test/j.json'),
    });
    token = { symbol: ['X'], extra: { decimals: '4' } };
    expect(await h.run(h.reader.getTokenMetadata!(jetton(MASTER)))).toEqual({
      symbol: 'TST',
      decimals: 4,
    });
  });

  it('looks a lookup id up as the run that consumed the seqno (F6-R13 M5)', async () => {
    const h = tonHarness();
    const wallet = testWallet('v4r2', TESTNET);
    const { boc, hashNorm } = v4Request(h, 0, [
      [1, nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    ]);
    h.node.fund(wallet, GRAM / 10n);
    h.node.submit(boc);
    h.node.mine(2);
    h.node.fund(wallet, 3n * GRAM);
    h.node.submit(boc);
    h.node.mine(3);
    const runs = await h.run(h.ctx.api.transactionsByMessage(hashNorm, READ));
    expect(runs.map(consumesSeqno)).toEqual([false, true]);
    const found = await h.run(h.reader.getTransaction(hashNorm));
    expect(found).toMatchObject({ id: runs[1]?.hash, observation: { success: true } });
    const unmanaged = { id: hashNorm, idKind: 'message-hash' as const, canonical: false };
    expect(await h.run(h.reader.observe(unmanaged, undefined, undefined))).toMatchObject({
      txHash: runs[1]?.hash,
      success: true,
    });
  });

  it('derives ext.ton.jettonWallet under the proof quorum, and keeps it (F6-R13 M6)', async () => {
    const h = tonHarness({ endpoints: ['a', 'b'] });
    const owner = testWallet('v4r2', TESTNET);
    h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const tags: unknown[] = [];
    const original = h.rpc.http.bind(h.rpc);
    h.rpc.http = ((request, options) => {
      if (request.route === '/runGetMethod') {
        tags.push({ purpose: options?.purpose, quorum: options?.quorum });
      }
      return original(request, options);
    }) as typeof h.rpc.http;
    let edit = (bytes: string): string => bytes;
    rewrite(
      h,
      (endpoint, route, request) =>
        endpoint === 'b' && getMethod(route, request, 'get_wallet_address'),
      (json) => {
        const result = json.result as Json;
        const [[type, cell]] = result.stack as [[string, Json]];
        const bytes = edit(cell.bytes as string);
        return { ...json, result: { ...result, stack: [[type, { ...cell, bytes }]] } };
      },
    );
    // Another endpoint names another wallet: nothing is decided.
    edit = () => addressArgumentOf(`0:${'66'.repeat(32)}`);
    await expect(h.run(h.ext.ton.jettonWallet(owner, MASTER))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    // The same address serialized otherwise agrees; the attested answer is kept.
    edit = (bytes) =>
      Cell.fromBoc(Buffer.from(bytes, 'base64'))[0]!
        .toBoc({ idx: true, crc32: false })
        .toString('base64');
    const wallet = h.node.jettonWalletOf(MASTER, owner);
    expect(await h.run(h.ext.ton.jettonWallet(owner, MASTER))).toBe(wallet);
    const proof = { purpose: 'proof', quorum: 'proof' };
    expect(tags).toEqual([proof, proof]);
    const served = h.node.served.length;
    expect(await h.run(h.ext.ton.jettonWallet(owner, MASTER))).toBe(wallet);
    expect(h.node.served).toHaveLength(served);
  });

  it('refuses a frozen wallet from its state, before any get-method', async () => {
    const h = tonHarness();
    const wallet = testWallet('v4r2', TESTNET);
    h.node.deployWallet(wallet, {
      version: 'v4r2',
      publicKey: Buffer.from(PUBLIC_KEY, 'hex'),
      walletId: 698983191,
      seqno: 3,
    });
    h.node.freeze(wallet);
    const before = h.node.served.length;
    await expect(h.run(h.sequence.pending(wallet))).rejects.toMatchObject({
      code: 'TX_REFUSED',
    });
    await expect(h.run(h.ext.ton.getSeqno(wallet))).rejects.toMatchObject({
      code: 'TX_REFUSED',
    });
    expect(h.node.served.slice(before).map((s) => s.route)).toEqual([
      '/getAddressInformation',
      '/getAddressInformation',
    ]);
  });

  it('decides nothing when more history than the floor reads is newer than the live read', async () => {
    const h = tonHarness();
    const { wallet } = await pay(h, false);
    h.node.mine(3);
    // Four pages of deposits, and one more, all newer than the live read.
    const payer = `0:${'33'.repeat(32)}`;
    for (let i = 0; i < 4 * 64 + 1; i++) {
      h.node.inject(payer, wallet, 1_000_000n, beginCell().endCell());
    }
    h.node.mine(2);
    h.node.lagEndpoint('main', 2);
    await expect(h.run(h.sequence.pending(wallet))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // Once the live read covers them, it decides alone.
    h.node.lagEndpoint('main', 0);
    expect(await h.run(h.sequence.pending(wallet))).toBe(1n);
  });

  it('never reports a block the indexer and the liteserver name differently', async () => {
    const h = tonHarness();
    h.node.mine(3);
    const block = await h.run(h.reader.getBlock(3n));
    // The indexer names another block's seqno for this hash.
    h.node.intercept = (_e, route) =>
      route === '/blocks'
        ? {
            json: {
              blocks: [
                {
                  workchain: -1,
                  shard: '8000000000000000',
                  seqno: 2,
                  root_hash: Buffer.from(block!.hash, 'hex').toString('base64'),
                },
              ],
            },
          }
        : undefined;
    await expect(h.run(h.reader.getBlock(block!.hash))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('reads ids in either case, and a height outside the masterchain as no block', async () => {
    const h = tonHarness();
    const { hashNorm } = await pay(h, false);
    h.node.mine(2);
    const tx = await h.run(h.reader.getTransaction(hashNorm));
    expect((await h.run(h.reader.getTransaction(hashNorm.toUpperCase())))?.id).toBe(
      tx?.id,
    );
    const block = await h.run(h.reader.getBlock(2n));
    expect(await h.run(h.reader.getBlock(block!.hash.toUpperCase()))).toEqual(block);
    expect(await h.run(h.reader.getBlock(-1n))).toBeNull();
    expect(await h.run(h.reader.getBlock(2n ** 32n))).toBeNull();
  });
});
