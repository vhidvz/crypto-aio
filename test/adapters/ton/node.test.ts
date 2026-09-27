import { ed25519 } from '@noble/curves/ed25519';
import {
  Cell,
  beginCell,
  external,
  loadMessage,
  storeMessage,
  storeOutList,
} from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { OP, jettonMessage, nativeMessage } from '../../../src/adapters/ton/messages';
import { resolveIdentity, walletIdOf } from '../../../src/adapters/ton/wallets';
import { NODE_FEES } from './support/node';
import { relayedBody, signedBoc, testWallet, tonNode } from './support/harness';
import { KEY, PUBLIC_KEY } from './support/vectors';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const RECIPIENT = `0:${'11'.repeat(32)}`;
const MASTER = `0:${'77'.repeat(32)}`;

async function post(url: string, body: unknown, fetchFn: typeof fetch) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function get(url: string, fetchFn: typeof fetch) {
  const response = await fetchFn(url);
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function setup(version: 'v4r2' | 'v5r1' = 'v4r2', options = {}) {
  const t = tonNode(options);
  const v2 = t.node.endpoint('main', 'v2');
  const v3 = t.node.endpoint('main', 'v3');
  const wallet = testWallet(version, TESTNET);
  const now = () => Math.floor(t.clock.now() / 1000);
  return { ...t, v2, v3, wallet, now, fetchFn: t.node.fetch.fetch };
}

describe('the scripted toncenter node: wallets', () => {
  it.each(['v4r2', 'v5r1'] as const)(
    'deploys %s with its first message and consumes the seqno',
    async (version) => {
      const s = setup(version);
      s.node.fund(s.wallet, 2n * GRAM);
      const { boc, hashNorm } = await signedBoc(version, TESTNET, {
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [
          nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false, memo: 'hi' }),
        ],
      });
      const sent = await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
      expect(sent.status).toBe(200);
      expect(
        Buffer.from(
          String((sent.json.result as Record<string, unknown>).hash_norm),
          'base64',
        ).toString('hex'),
      ).toBe(hashNorm);
      s.node.mine();
      expect(s.node.status(s.wallet)).toBe('active');
      expect(s.node.seqno(s.wallet)).toBe(1);
      s.node.mine();
      expect(s.node.balance(RECIPIENT)).toBe(GRAM);
      expect(s.node.status(RECIPIENT)).toBe('uninitialized');
    },
  );

  it('refuses at send time what the wallet would refuse, with HTTP 500 like toncenter', async () => {
    const s = setup('v4r2');
    const message = nativeMessage({ to: RECIPIENT, value: 1n, bounce: false });
    const undeployed = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: false,
      messages: [message],
    });
    let answer = await post(
      `${s.v2}/sendBocReturnHash`,
      { boc: undeployed.boc },
      s.fetchFn,
    );
    expect(answer.status).toBe(500);
    expect(String(answer.json.error)).toMatch(/not initialized/);
    const unfunded = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [message],
    });
    answer = await post(`${s.v2}/sendBocReturnHash`, { boc: unfunded.boc }, s.fetchFn);
    expect(String(answer.json.error)).toMatch(/not enough balance/);
    s.node.fund(s.wallet, GRAM);
    const expired = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now(),
      deploy: true,
      messages: [message],
    });
    answer = await post(`${s.v2}/sendBocReturnHash`, { boc: expired.boc }, s.fetchFn);
    expect(String(answer.json.error)).toMatch(/exitcode=36/);
    const wrongSeqno = await signedBoc('v4r2', TESTNET, {
      seqno: 5,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [message],
    });
    answer = await post(`${s.v2}/sendBocReturnHash`, { boc: wrongSeqno.boc }, s.fetchFn);
    expect(String(answer.json.error)).toMatch(/exitcode=33/);
  });

  it('never includes a message whose lifetime passed before its block', async () => {
    const s = setup('v5r1');
    s.node.fund(s.wallet, GRAM);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 5,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    expect((await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn)).status).toBe(
      200,
    );
    await s.clock.advance(6_000);
    s.node.mine();
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.transactions()).toHaveLength(0);
  });

  it('skips a message the balance cannot pay (send mode +2), yet consumes the seqno', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM / 10n);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
    });
    await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(1);
    const [tx] = s.node.transactions();
    expect(tx?.outMsgs).toHaveLength(0);
    expect(tx?.description).toMatchObject({
      aborted: false,
      action: { skipped_actions: 1 },
    });
    expect(s.node.balance(RECIPIENT)).toBe(0n);
  });

  it('bounces a bounceable transfer to an uninitialized account, and keeps a non-bounceable one', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [
        nativeMessage({ to: RECIPIENT, value: GRAM, bounce: true }),
        nativeMessage({ to: `0:${'12'.repeat(32)}`, value: GRAM, bounce: false }),
      ],
    });
    await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
    s.node.mine(3);
    expect(s.node.balance(RECIPIENT)).toBe(0n);
    expect(s.node.balance(`0:${'12'.repeat(32)}`)).toBe(GRAM);
    const bounced = s.node.transactions().find((t) => t.account === RECIPIENT);
    expect(bounced?.description).toMatchObject({ aborted: true, bounce: { type: 'ok' } });
    const back = s.node.transactions().at(-1);
    expect(back?.account).toBe(s.wallet);
    expect(back?.inMsg).toMatchObject({
      bounced: true,
      value: GRAM - NODE_FEES.internalGas,
    });
  });
});

describe('the scripted toncenter node: jettons', () => {
  async function jettonSetup(amount: bigint) {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 2n * GRAM);
    s.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.node.mintJetton(MASTER, s.wallet, 1_000_000n);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [
        jettonMessage({
          jettonWallet: s.node.jettonWalletOf(MASTER, s.wallet),
          attached: 50_000_000n,
          queryId: 0n,
          amount,
          destination: RECIPIENT,
          responseDestination: s.wallet,
          forwardAmount: 1n,
          memo: 'order 9',
        }),
      ],
    });
    await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
    return s;
  }

  it('moves jettons, notifies the recipient and refunds the excess', async () => {
    const s = await jettonSetup(400_000n);
    s.node.mine(5);
    expect(s.node.jettonBalance(MASTER, s.wallet)).toBe(600_000n);
    expect(s.node.jettonBalance(MASTER, RECIPIENT)).toBe(400_000n);
    expect(s.node.balance(RECIPIENT)).toBe(1n);
    const accounts = s.node.transactions().map((t) => t.account);
    expect(accounts).toEqual([
      s.wallet,
      s.node.jettonWalletOf(MASTER, s.wallet),
      s.node.jettonWalletOf(MASTER, RECIPIENT),
      RECIPIENT,
      s.wallet,
    ]);
  });

  it('bounces a transfer above the jetton balance back to the owner', async () => {
    const s = await jettonSetup(2_000_000n);
    s.node.mine(4);
    expect(s.node.jettonBalance(MASTER, s.wallet)).toBe(1_000_000n);
    const jw = s.node.transactions()[1];
    expect(jw?.description).toMatchObject({ aborted: true, bounce: { type: 'ok' } });
  });

  it("returns the amount when the recipient's jetton wallet fails the internal_transfer", async () => {
    const s = await jettonSetup(300_000n);
    s.node.failJettonWallet(s.node.jettonWalletOf(MASTER, RECIPIENT));
    s.node.mine(5);
    expect(s.node.jettonBalance(MASTER, s.wallet)).toBe(1_000_000n);
    expect(s.node.jettonBalance(MASTER, RECIPIENT)).toBe(0n);
  });

  it('answers the get-methods of masters and jetton wallets', async () => {
    const s = await jettonSetup(1n);
    const data = await post(
      `${s.v2}/runGetMethod`,
      {
        address: s.node.jettonWalletOf(MASTER, s.wallet),
        method: 'get_wallet_data',
        stack: [],
      },
      s.fetchFn,
    );
    expect(data.json.result).toMatchObject({
      exit_code: 0,
      stack: [
        ['num', '0xf4240'],
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    });
    const missing = await post(
      `${s.v2}/runGetMethod`,
      { address: RECIPIENT, method: 'seqno', stack: [] },
      s.fetchFn,
    );
    expect(missing.json.result).toMatchObject({ exit_code: -13 });
  });
});

describe('the scripted toncenter node: indexer and history', () => {
  it('trails the chain by indexerLag and completes a trace only when every hop is indexed', async () => {
    const s = setup('v4r2', { indexerLag: 2 });
    s.node.fund(s.wallet, 2n * GRAM);
    const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
    });
    await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
    s.node.mine();
    let byMessage = await get(
      `${s.v3}/transactionsByMessage?msg_hash=${hashNorm}&direction=in`,
      s.fetchFn,
    );
    expect(byMessage.json.transactions).toEqual([]);
    s.node.mine(2);
    byMessage = await get(
      `${s.v3}/transactionsByMessage?msg_hash=${hashNorm}&direction=in`,
      s.fetchFn,
    );
    const [root] = byMessage.json.transactions as Record<string, unknown>[];
    expect(root?.mc_block_seqno).toBe(2);
    const hash = Buffer.from(String(root?.hash), 'base64').toString('hex');
    let traces = await get(`${s.v3}/traces?tx_hash=${hash}`, s.fetchFn);
    expect((traces.json.traces as Record<string, unknown>[])[0]).toMatchObject({
      is_incomplete: true,
    });
    s.node.mine();
    traces = await get(`${s.v3}/traces?tx_hash=${hash}`, s.fetchFn);
    expect((traces.json.traces as Record<string, unknown>[])[0]).toMatchObject({
      is_incomplete: false,
      trace_info: { trace_state: 'complete' },
    });
    const head = await get(`${s.v3}/masterchainInfo`, s.fetchFn);
    expect((head.json.last as Record<string, unknown>).seqno).toBe(s.node.head - 2);
  });

  it('serves state at an older masterchain block, and refuses a block past its head', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM);
    s.node.mine();
    const before = s.node.head;
    s.node.mine();
    // Scripted changes land in the newest block; older blocks keep their state.
    s.node.fund(s.wallet, GRAM);
    const old = await get(
      `${s.v2}/getAddressInformation?address=${s.wallet}&seqno=${before}`,
      s.fetchFn,
    );
    expect((old.json.result as Record<string, unknown>).balance).toBe(String(GRAM));
    const future = await get(
      `${s.v2}/getBlockHeader?workchain=-1&shard=-9223372036854775808&seqno=${s.node.head + 1}`,
      s.fetchFn,
    );
    expect(future.status).toBe(500);
    expect(String(future.json.error)).toMatch(/LITE_SERVER_NOTREADY/);
  });
});

describe('the scripted toncenter node: fidelity (lesson 8)', () => {
  it('emulates fees with the real forward fee of every requested message (I3)', async () => {
    const s = setup('v4r2');
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: false,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false, memo: 'x' })],
    });
    const body = loadMessage(
      Cell.fromBoc(Buffer.from(boc, 'base64'))[0]!.beginParse(),
    ).body;
    const fees = await post(
      `${s.v2}/estimateFee`,
      {
        address: s.wallet,
        body: body.toBoc().toString('base64'),
        init_code: '',
        init_data: '',
      },
      s.fetchFn,
    );
    const source = (fees.json.result as { source_fees: Record<string, number> })
      .source_fees;
    expect(source.fwd_fee).toBeGreaterThan(0);
    expect(source.in_fwd_fee).toBe(Number(NODE_FEES.importFee));
  });

  it('commits a W5 seqno, then aborts with 137, for a request without send mode +2', async () => {
    const s = setup('v5r1');
    s.node.fund(s.wallet, GRAM);
    const identity = resolveIdentity({ ton: { version: 'v5r1' } }, TESTNET);
    const key = Buffer.from(PUBLIC_KEY, 'hex');
    const contract = WalletContractV5R1.create({
      publicKey: key,
      walletId: {
        networkGlobalId: TESTNET,
        context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 },
      },
    });
    // The SDK always adds +2 for externals, so the signing message is built by hand here.
    const action = {
      type: 'sendMsg' as const,
      mode: 1,
      outMsg: nativeMessage({ to: RECIPIENT, value: 1n, bounce: false }),
    };
    const signing = beginCell()
      .storeUint(OP.w5SignedExternal, 32)
      .storeInt(walletIdOf(identity, key), 32)
      .storeUint(s.now() + 60, 32)
      .storeUint(0, 32)
      .storeMaybeRef(
        beginCell()
          .store(storeOutList([action]))
          .endCell(),
      )
      .storeBit(false);
    const signature = ed25519.sign(signing.endCell().hash(), Buffer.from(KEY, 'hex'));
    const body = signing.storeBuffer(Buffer.from(signature)).endCell();
    const message = beginCell()
      .store(storeMessage(external({ to: contract.address, body, init: contract.init })))
      .endCell();
    s.node.submit(message.toBoc().toString('base64'));
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(1);
    const [tx] = s.node.transactions();
    expect(tx?.description).toMatchObject({
      aborted: true,
      compute_ph: { exit_code: 137 },
    });
    expect(tx?.outMsgs).toHaveLength(0);
    expect(s.node.balance(RECIPIENT)).toBe(0n);
  });

  it('runs a relayed v5r1 request only when the wallet key signed it (A23)', async () => {
    const s = setup('v5r1');
    const relayer = `0:${'22'.repeat(32)}`;
    s.node.fund(s.wallet, 2n * GRAM);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    s.node.submit(boc);
    s.node.mine();
    const relayed = (seed?: string) =>
      relayedBody(TESTNET, {
        seqno: 1,
        validUntil: s.now() + 60,
        messages: [nativeMessage({ to: RECIPIENT, value: 5n, bounce: false })],
        ...(seed !== undefined ? { seed } : {}),
      });
    const fromRelayer = () =>
      s.node
        .transactions()
        .filter((t) => t.account === s.wallet && t.inMsg?.source === relayer);
    // Forged (another key signed it): wallet_v5.fc ignores it, and the transaction succeeds.
    s.node.inject(relayer, s.wallet, 50_000_000n, relayed('ab'.repeat(32)));
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(1);
    expect(fromRelayer()[0]?.description).toMatchObject({
      aborted: false,
      compute_ph: { success: true },
    });
    s.node.inject(relayer, s.wallet, 50_000_000n, relayed());
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(2);
    expect(s.node.balance(RECIPIENT)).toBe(6n);
    const key = await post(
      `${s.v2}/runGetMethod`,
      { address: s.wallet, method: 'get_public_key', stack: [] },
      s.fetchFn,
    );
    expect((key.json.result as { stack: unknown[] }).stack).toEqual([
      ['num', `0x${PUBLIC_KEY}`],
    ]);
  });

  it('serves two shards, each with its own time (D9)', async () => {
    const s = setup('v4r2', { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 9 });
    s.node.mine();
    const shards = await get(`${s.v2}/getShards?seqno=${s.node.head}`, s.fetchFn);
    const ids = (shards.json.result as { shards: { shard: string; seqno: number }[] })
      .shards;
    expect(ids.map((id) => id.shard)).toEqual([
      '-9223372036854775808',
      '-4611686018427387904',
    ]);
    const times = [];
    for (const id of ids) {
      const header = await get(
        `${s.v2}/getBlockHeader?workchain=0&shard=${id.shard}&seqno=${id.seqno}`,
        s.fetchFn,
      );
      times.push((header.json.result as { gen_utime: number }).gen_utime);
    }
    const mc = s.node.block(s.node.head)!.genUtime;
    expect(times).toEqual([mc - 1, mc - 9]);
  });
});
