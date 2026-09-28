import { ed25519 } from '@noble/curves/ed25519';
import {
  Address,
  Cell,
  SendMode,
  beginCell,
  external,
  internal,
  loadMessage,
  loadTransaction,
  storeMessage,
  storeMessageRelaxed,
  storeOutList,
  type MessageRelaxed,
} from '@ton/core';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import {
  OP,
  jettonMessage,
  nativeMessage,
  sdkAddress,
} from '../../../src/adapters/ton/messages';
import {
  SEND_MODE,
  resolveIdentity,
  walletIdOf,
} from '../../../src/adapters/ton/wallets';
import { hang } from '../../../src/testing/fake-fetch';
import { NODE_FEES, type ScriptedTonNode } from './support/node';
import {
  relayedBody,
  signedBoc,
  testWallet,
  tonNode as makeNode,
} from './support/harness';
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

/** Every node a test makes: after the test, each of its transactions is shape-checked. */
const made: ScriptedTonNode[] = [];

function tonNode(...args: Parameters<typeof makeNode>) {
  const t = makeNode(...args);
  made.push(t.node);
  return t;
}

/**
 * F6-R11, transaction.cpp: `compute_ph.success = accepted && committed`; the action phase
 * exists exactly when the compute phase succeeded (`act`); `aborted = !(act && action
 * succeeded)`. Every transaction the node writes has that shape.
 */
afterEach(() => {
  for (const node of made.splice(0)) {
    for (const tx of node.transactions()) {
      const d = tx.description as {
        aborted: boolean;
        compute_ph: { success?: boolean };
        action?: { success: boolean };
      };
      const act = d.compute_ph.success === true;
      expect({ hash: tx.hash, action: d.action !== undefined }).toEqual({
        hash: tx.hash,
        action: act,
      });
      expect({ hash: tx.hash, aborted: d.aborted }).toEqual({
        hash: tx.hash,
        aborted: !(act && d.action?.success === true),
      });
    }
  }
});

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
    // F6-R7: the liteserver's own texts (live toncenter for an account that does not exist).
    expect(answer.status).toBe(500);
    expect(String(answer.json.error)).toMatch(/: Failed to unpack account state$/);
    const unfunded = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [message],
    });
    answer = await post(`${s.v2}/sendBocReturnHash`, { boc: unfunded.boc }, s.fetchFn);
    expect(String(answer.json.error)).toMatch(/: Failed to unpack account state$/);
    // Funded, yet no code and no StateInit: the compute phase is skipped (no_state).
    s.node.fund(s.wallet, GRAM);
    answer = await post(`${s.v2}/sendBocReturnHash`, { boc: undeployed.boc }, s.fetchFn);
    expect(String(answer.json.error)).toBe(skippedCompute(s.wallet));
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
    // tonlib buys the emulated run's gas with the balance (F6-R17): a funded wallet.
    s.node.fund(s.wallet, GRAM);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false, memo: 'x' })],
    });
    const { body, init } = loadMessage(
      Cell.fromBoc(Buffer.from(boc, 'base64'))[0]!.beginParse(),
    );
    // An undeployed wallet is emulated with its StateInit, as the driver sends it (D13).
    const fees = await post(
      `${s.v2}/estimateFee`,
      {
        address: s.wallet,
        body: body.toBoc().toString('base64'),
        init_code: init!.code!.toBoc().toString('base64'),
        init_data: init!.data!.toBoc().toString('base64'),
      },
      s.fetchFn,
    );
    const source = (fees.json.result as { source_fees: Record<string, number> })
      .source_fees;
    expect(source.fwd_fee).toBeGreaterThan(0);
    expect(source.in_fwd_fee).toBe(Number(NODE_FEES.importFee));
  });

  it.each(['v4r2', 'v5r1'] as const)(
    'emulates a %s run only as its balance and its own checks allow, as tonlib does (F6-R17)',
    async (version) => {
      const s = setup(version);
      // tonlib `Query::estimate_fees`: gas is bought with the balance (`compute_gas_limits`),
      // `gas_fee` counts only an accepted run and `fwd_fee` only a successful one.
      const request = async (seqno: number, validUntil = s.now() + 60) => {
        const { boc } = await signedBoc(version, TESTNET, {
          seqno,
          validUntil,
          deploy: true,
          messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
        });
        const { body, init } = loadMessage(
          Cell.fromBoc(Buffer.from(boc, 'base64'))[0]!.beginParse(),
        );
        return {
          address: s.wallet,
          body: body.toBoc().toString('base64'),
          init_code: init!.code!.toBoc().toString('base64'),
          init_data: init!.data!.toBoc().toString('base64'),
        };
      };
      const fees = async (body: Record<string, string>) =>
        (
          (await post(`${s.v2}/estimateFee`, body, s.fetchFn)).json.result as {
            source_fees: Record<string, number>;
          }
        ).source_fees;
      const gas =
        (version === 'v4r2' ? NODE_FEES.gasV4 : NODE_FEES.gasV5) + NODE_FEES.deployGas;
      // No balance, or one below the flat gas price, buys no gas: nothing runs.
      expect(await fees(await request(0))).toMatchObject({ gas_fee: 0, fwd_fee: 0 });
      s.node.fund(s.wallet, NODE_FEES.flatGas - 1n);
      expect(await fees(await request(0))).toMatchObject({ gas_fee: 0, fwd_fee: 0 });
      // A balance below the run's cost runs out of gas after the accept: nothing is sent.
      s.node.fund(s.wallet, gas - NODE_FEES.flatGas);
      expect(await fees(await request(0))).toMatchObject({
        gas_fee: Number(gas - 1n),
        fwd_fee: 0,
      });
      s.node.fund(s.wallet, 1n);
      expect(await fees(await request(0))).toMatchObject({ gas_fee: Number(gas) });
      expect((await fees(await request(0))).fwd_fee).toBeGreaterThan(0);
      // The wallet code refuses another seqno, or an expired request, before its accept.
      expect(await fees(await request(1))).toMatchObject({ gas_fee: 0, fwd_fee: 0 });
      expect(await fees(await request(0, s.now()))).toMatchObject({
        gas_fee: 0,
        fwd_fee: 0,
      });
    },
  );

  it('commits a W5 seqno, then throws 137, for a request without send mode +2 (transaction.cpp)', async () => {
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
    // F6-R11: `success = accepted && committed`, and the VM committed before the throw, so
    // the compute phase succeeded with 137; the empty action list committed with the seqno
    // then runs, and the transaction is not aborted. The indexer reports it so.
    const [served] = (
      await get(`${s.v3}/transactions?account=${s.wallet}&limit=1`, s.fetchFn)
    ).json.transactions as { description: Record<string, unknown> }[];
    for (const description of [tx?.description, served?.description]) {
      expect(description).toEqual({
        type: 'ord',
        aborted: false,
        compute_ph: { skipped: false, success: true, exit_code: 137 },
        action: {
          success: true,
          valid: true,
          no_funds: false,
          result_code: 0,
          tot_actions: 0,
          skipped_actions: 0,
          msgs_created: 0,
        },
      });
    }
    expect(tx?.totalFees).toBe(
      NODE_FEES.importFee + NODE_FEES.gasV5 + NODE_FEES.deployGas,
    );
    // M3: the trace is named after its root transaction.
    expect(tx?.traceId).toBe(tx?.hash);
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
    // M3: an injected message's delivery is its trace's root.
    expect(fromRelayer()[0]?.traceId).toBe(fromRelayer()[0]?.hash);
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
      '4611686018427387904',
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

const FRESH = `0:${'12'.repeat(32)}`;
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/** Signs with the test key, as the wallet's owner does. */
const signer = async (cell: Cell): Promise<Buffer> =>
  Buffer.from(ed25519.sign(cell.hash(), Buffer.from(KEY, 'hex')));

/** The test key's wallet contract; `subwallet` changes its wallet id (default the network's). */
function contractOf(version: 'v4r2' | 'v5r1', subwallet = 0) {
  const publicKey = Buffer.from(PUBLIC_KEY, 'hex');
  return version === 'v4r2'
    ? WalletContractV4.create({
        workchain: 0,
        publicKey,
        walletId: 698983191 + subwallet,
      })
    : WalletContractV5R1.create({
        publicKey,
        walletId: {
          networkGlobalId: TESTNET,
          context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: subwallet },
        },
      });
}

/**
 * A request the SDK builds with any send mode and wallet id, sent to the test key's default
 * wallet (with its `StateInit` when `deploy`).
 */
async function sdkRequest(
  version: 'v4r2' | 'v5r1',
  args: {
    readonly seqno: number;
    readonly validUntil: number;
    readonly sendMode: number;
    readonly deploy: boolean;
    readonly messages: MessageRelaxed[];
    readonly subwallet?: number;
  },
): Promise<string> {
  const own = contractOf(version);
  const signing = contractOf(version, args.subwallet ?? 0);
  const transfer = {
    seqno: args.seqno,
    timeout: args.validUntil,
    sendMode: args.sendMode,
    messages: args.messages,
    signer,
  };
  const body =
    signing instanceof WalletContractV4
      ? await signing.createTransfer(transfer)
      : await signing.createTransfer(transfer);
  return beginCell()
    .store(
      storeMessage(
        external({ to: own.address, body, ...(args.deploy ? { init: own.init } : {}) }),
      ),
    )
    .endCell()
    .toBoc()
    .toString('base64');
}

/** The liteserver's refusal of an external whose compute phase did not run (collator.cpp). */
function skippedCompute(account: string): string {
  return `LITE_SERVER_UNKNOWN: cannot apply external message to current state : External message was not accepted: cannot run message on account: inbound external message rejected by transaction ${account.slice(2).toUpperCase()}:\nexitcode=0, steps=0, gas_used=0`;
}

/** A v4r2 request for the test key's wallet with each message's own send mode. */
function v4Modes(args: {
  readonly seqno: number;
  readonly validUntil: number;
  readonly deploy: boolean;
  readonly messages: readonly (readonly [number, MessageRelaxed])[];
}): string {
  const own = contractOf('v4r2');
  const signing = beginCell()
    .storeUint(698983191, 32)
    .storeUint(args.validUntil, 32)
    .storeUint(args.seqno, 32)
    .storeUint(0, 8);
  for (const [mode, message] of args.messages) {
    signing.storeUint(mode, 8).storeRef(beginCell().store(storeMessageRelaxed(message)));
  }
  const cell = signing.endCell();
  const signature = ed25519.sign(cell.hash(), Buffer.from(KEY, 'hex'));
  const body = beginCell()
    .storeBuffer(Buffer.from(signature))
    .storeSlice(cell.beginParse())
    .endCell();
  return beginCell()
    .store(
      storeMessage(
        external({ to: own.address, body, ...(args.deploy ? { init: own.init } : {}) }),
      ),
    )
    .endCell()
    .toBoc()
    .toString('base64');
}

/** A TEP-74 `internal_transfer` of `amount`, naming `from` as the sending owner. */
function internalTransfer(amount: bigint, from: string | null): Cell {
  return beginCell()
    .storeUint(OP.jettonInternalTransfer, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(from === null ? null : sdkAddress(from))
    .storeAddress(null)
    .storeCoins(0)
    .storeBit(false)
    .endCell();
}

describe('the scripted toncenter node: never more lenient than the chain (F6-R5)', () => {
  it.each([
    ['below', NODE_FEES.internalGas - 1n, 'nofunds'],
    ['exactly at', NODE_FEES.internalGas, 'ok'],
  ] as const)(
    'bounces a value %s the bounce cost as transaction.cpp does (nofunds only below it, M7)',
    async (_where, value, type) => {
      const s = setup('v4r2');
      s.node.fund(s.wallet, GRAM);
      const { boc } = await signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [nativeMessage({ to: RECIPIENT, value, bounce: true })],
      });
      s.node.submit(boc);
      s.node.mine(3);
      const delivery = s.node.transactions().find((t) => t.account === RECIPIENT);
      expect(delivery?.description).toMatchObject({
        aborted: true,
        compute_ph: { skipped: true, reason: 'no_state' },
        bounce: { type },
      });
      if (type === 'nofunds') {
        // Too little to pay for the bounce: the value stays.
        expect(delivery?.outMsgs).toHaveLength(0);
        expect(s.node.balance(RECIPIENT)).toBe(value);
        expect(s.node.transactions()).toHaveLength(2);
      } else {
        // Exactly enough: the bounce goes back carrying nothing.
        expect(delivery?.outMsgs.map((m) => [m.destination, m.value])).toEqual([
          [s.wallet, 0n],
        ]);
        expect(s.node.balance(RECIPIENT)).toBe(0n);
        expect(s.node.transactions()).toHaveLength(3);
      }
    },
  );

  it('fails the action phase of an unpayable message without send mode +2: seqno kept, gas charged, replayable', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM / 10n);
    const boc = await sdkRequest('v4r2', {
      seqno: 0,
      validUntil: s.now() + 60,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
    });
    s.node.submit(boc);
    s.node.mine(2);
    const charged = NODE_FEES.importFee + NODE_FEES.gasV4 + NODE_FEES.deployGas;
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.status(s.wallet)).toBe('active');
    expect(s.node.balance(s.wallet)).toBe(GRAM / 10n - charged);
    const [tx] = s.node.transactions();
    expect(tx?.outMsgs).toHaveLength(0);
    expect(tx?.description).toMatchObject({
      aborted: true,
      compute_ph: { success: true, exit_code: 0 },
      action: { success: false, result_code: 37, msgs_created: 0 },
    });
    // The seqno did not move, so the same message applies again until it expires.
    expect((await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn)).status).toBe(
      200,
    );
    s.node.mine();
    expect(s.node.transactions()).toHaveLength(2);
    expect(s.node.balance(s.wallet)).toBe(
      GRAM / 10n - charged - NODE_FEES.importFee - NODE_FEES.gasV4,
    );
    expect(s.node.balance(RECIPIENT)).toBe(0n);
  });

  it('takes the forward fee out of the value without send mode +1', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 2n * GRAM);
    const boc = await sdkRequest('v4r2', {
      seqno: 0,
      validUntil: s.now() + 60,
      sendMode: SendMode.IGNORE_ERRORS,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
    });
    s.node.submit(boc);
    s.node.mine(2);
    const [tx] = s.node.transactions();
    const gas = NODE_FEES.importFee + NODE_FEES.gasV4 + NODE_FEES.deployGas;
    const fwd = tx!.totalFees - gas;
    expect(fwd).toBeGreaterThan(0n);
    expect(tx?.outMsgs[0]?.value).toBe(GRAM - fwd);
    expect(s.node.balance(RECIPIENT)).toBe(GRAM - fwd);
    expect(s.node.balance(s.wallet)).toBe(GRAM - gas);
  });

  it("fails a relayed request's action phase without +2: seqno kept, no bounce, value kept (wallet_v5.fc)", async () => {
    const s = setup('v5r1');
    const relayer = `0:${'22'.repeat(32)}`;
    s.node.fund(s.wallet, GRAM / 10n);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    s.node.submit(boc);
    s.node.mine();
    const body = relayedBody(TESTNET, {
      seqno: 1,
      validUntil: s.now() + 60,
      messages: [nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
      sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
    const before = s.node.balance(s.wallet);
    s.node.inject(relayer, s.wallet, 50_000_000n, body, true);
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(1);
    const tx = s.node.transactions().find((t) => t.inMsg.source === relayer);
    expect(tx?.description).toMatchObject({
      aborted: true,
      compute_ph: { success: true },
      action: { success: false, no_funds: true, result_code: 37 },
    });
    // F6-R7: an action failure bounces only with send mode +16 (transaction.cpp
    // `need_bounce_on_fail`); the bounce phase needs a failed compute phase (collator.cpp).
    expect(tx?.description).not.toHaveProperty('bounce');
    expect(tx?.outMsgs).toHaveLength(0);
    expect(s.node.balance(s.wallet)).toBe(before + 50_000_000n);
    expect(s.node.balance(RECIPIENT)).toBe(1n);
  });

  it('fails a message whose value cannot pay its own forward fee without +1 (37, no_funds)', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM);
    s.node.submit(
      v4Modes({
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [[0, nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })]],
      }),
    );
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.transactions()[0]?.description).toMatchObject({
      aborted: true,
      action: { success: false, valid: true, no_funds: true, result_code: 37 },
    });
    expect(s.node.balance(RECIPIENT)).toBe(0n);
  });

  it('refuses a send mode it does not model (34): the list stays valid, earlier skips count', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM / 10n);
    s.node.submit(
      v4Modes({
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [
          [SEND_MODE, nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
          [SEND_MODE + 64, nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
        ],
      }),
    );
    s.node.mine(2);
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.transactions()[0]?.description).toMatchObject({
      aborted: true,
      action: {
        success: false,
        valid: true,
        no_funds: false,
        result_code: 34,
        skipped_actions: 1,
        msgs_created: 0,
      },
    });
  });

  it('refuses every message to a frozen wallet, its deploy StateInit included', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 2n * GRAM);
    const request = (seqno: number, validUntil: number, deploy: boolean) =>
      signedBoc('v4r2', TESTNET, {
        seqno,
        validUntil,
        deploy,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
      });
    s.node.submit((await request(0, s.now() + 60, true)).boc);
    s.node.mine(2);
    const accepted = await request(1, s.now() + 60, false);
    s.node.submit(accepted.boc);
    s.node.freeze(s.wallet);
    s.node.mine(2);
    // Accepted before the freeze: never included.
    expect(s.node.seqno(s.wallet)).toBe(1);
    expect(s.node.transactions().filter((t) => t.account === s.wallet)).toHaveLength(1);
    // Its deploy StateInit must not revive it at seqno 0 (a replay of seqnos 1..N-1).
    const replay = await request(0, s.now() + 61, true);
    for (const boc of [replay.boc, accepted.boc]) {
      const answer = await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
      expect(answer.status).toBe(500);
      // F6-R7: a frozen account runs no code; the chain's text, not an invented one.
      expect(String(answer.json.error)).toBe(skippedCompute(s.wallet));
    }
    expect(s.node.status(s.wallet)).toBe('frozen');
    expect(s.node.seqno(s.wallet)).toBe(1);
  });

  it('credits an internal_transfer only from the master or the owner’s jetton wallet (TEP-74 707)', async () => {
    const s = setup('v4r2');
    s.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const genuine = s.node.jettonWalletOf(MASTER, RECIPIENT);
    const impostor = `0:${'66'.repeat(32)}`;
    s.node.deployFakeJettonWallet(impostor, MASTER, s.wallet, 1_000_000n);
    s.node.inject(
      impostor,
      genuine,
      50_000_000n,
      internalTransfer(1_000_000n, s.wallet),
      true,
    );
    s.node.mine(2);
    expect(s.node.jettonBalance(MASTER, RECIPIENT)).toBe(0n);
    const refused = s.node.transactions().find((t) => t.account === genuine);
    expect(refused?.description).toMatchObject({
      aborted: true,
      compute_ph: { success: false, exit_code: 707 },
      bounce: { type: 'ok' },
    });
    // The master mints.
    s.node.inject(MASTER, genuine, 50_000_000n, internalTransfer(5n, null), true);
    s.node.mine(2);
    expect(s.node.jettonBalance(MASTER, RECIPIENT)).toBe(5n);
  });

  it('accepts a jetton transfer with no response destination (TEP-74 addr_none)', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 2n * GRAM);
    s.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.node.mintJetton(MASTER, s.wallet, 1_000_000n);
    const body = beginCell()
      .storeUint(OP.jettonTransfer, 32)
      .storeUint(0, 64)
      .storeCoins(400_000n)
      .storeAddress(sdkAddress(RECIPIENT))
      .storeAddress(null)
      .storeMaybeRef(null)
      .storeCoins(1n)
      .storeBit(false)
      .endCell();
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [
        internal({
          to: sdkAddress(s.node.jettonWalletOf(MASTER, s.wallet)),
          value: 50_000_000n,
          bounce: true,
          body,
        }),
      ],
    });
    s.node.submit(boc);
    s.node.mine(5);
    expect(s.node.jettonBalance(MASTER, RECIPIENT)).toBe(400_000n);
    expect(s.node.transactions().map((t) => t.account)).toEqual([
      s.wallet,
      s.node.jettonWalletOf(MASTER, s.wallet),
      s.node.jettonWalletOf(MASTER, RECIPIENT),
      RECIPIENT,
    ]);
  });

  it('serves jetton metadata from indexed state only (M6)', async () => {
    const s = setup('v4r2', { indexerLag: 2 });
    s.node.mine(3);
    s.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'offchain' });
    const masters = () =>
      get(`${s.v3}/jetton/masters?address=${MASTER}&limit=1`, s.fetchFn);
    const metadata = () => get(`${s.v3}/metadata?address=${MASTER}`, s.fetchFn);
    expect((await masters()).json.jetton_masters).toEqual([]);
    expect((await metadata()).json).toEqual({});
    s.node.mine(2);
    expect((await masters()).json.jetton_masters).toHaveLength(1);
    expect((await metadata()).json).toHaveProperty([MASTER.toUpperCase()]);
  });

  it('checks a message against a lagging endpoint’s own view, then again at inclusion (M6)', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 2n * GRAM);
    const request = (seqno: number, validUntil: number, deploy: boolean) =>
      signedBoc('v4r2', TESTNET, {
        seqno,
        validUntil,
        deploy,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
      });
    s.node.submit((await request(0, s.now() + 60, true)).boc);
    s.node.mine();
    s.node.lagEndpoint('main', 1);
    // The endpoint has not seen the deployment yet.
    const next = await request(1, s.now() + 60, false);
    const refused = await post(`${s.v2}/sendBocReturnHash`, { boc: next.boc }, s.fetchFn);
    expect(refused.status).toBe(500);
    expect(String(refused.json.error)).toBe(skippedCompute(s.wallet));
    // A stale request passes its view, and is never included.
    const stale = await request(0, s.now() + 61, true);
    const sent = await post(`${s.v2}/sendBocReturnHash`, { boc: stale.boc }, s.fetchFn);
    expect(sent.status).toBe(200);
    s.node.lagEndpoint('main', 0);
    s.node.mine();
    expect(s.node.seqno(s.wallet)).toBe(1);
    expect(s.node.transactions().filter((t) => t.account === s.wallet)).toHaveLength(1);
  });

  it('emulates fees on a lagging endpoint’s own view (M6)', async () => {
    const s = setup('v5r1');
    s.node.fund(s.wallet, GRAM);
    const { boc } = await signedBoc('v5r1', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    s.node.submit(boc);
    s.node.mine();
    const next = await signedBoc('v5r1', TESTNET, {
      seqno: 1,
      validUntil: s.now() + 60,
      deploy: false,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    const body = loadMessage(
      Cell.fromBoc(Buffer.from(next.boc, 'base64'))[0]!.beginParse(),
    )
      .body.toBoc()
      .toString('base64');
    const fees = async () =>
      (
        (
          await post(
            `${s.v2}/estimateFee`,
            { address: s.wallet, body, init_code: '', init_data: '' },
            s.fetchFn,
          )
        ).json.result as { source_fees: Record<string, number> }
      ).source_fees;
    expect(await fees()).toMatchObject({ gas_fee: Number(NODE_FEES.gasV5) });
    s.node.lagEndpoint('main', 1);
    // Not deployed in the endpoint's view: nothing runs, so no forward fee, and live
    // toncenter answers the flat gas price (F6-R7).
    expect(await fees()).toMatchObject({ gas_fee: 6667, fwd_fee: 0 });
  });

  it('answers errors in each API’s own envelope (M6)', async () => {
    const s = setup('v4r2');
    const v3 = await get(`${s.v3}/transactions?account=notanaddress&limit=1`, s.fetchFn);
    expect(v3.status).toBe(422);
    expect(v3.json).toEqual({ error: expect.any(String) });
    const v2 = await get(`${s.v2}/getAddressInformation?address=notanaddress`, s.fetchFn);
    expect(v2.status).toBe(422);
    expect(v2.json).toMatchObject({ ok: false, code: 422 });
    const lt = await get(
      `${s.v3}/transactions?account=${RECIPIENT}&end_lt=later&limit=1`,
      s.fetchFn,
    );
    expect(lt.status).toBe(422);
    expect(lt.json).toEqual({ error: expect.any(String) });
    // A shard this chain does not have (one shard: only -2^63), at a seqno past the head.
    const shard = await get(
      `${s.v2}/getBlockHeader?workchain=0&shard=4611686018427387904&seqno=1001`,
      s.fetchFn,
    );
    expect(shard.status).toBe(500);
    expect(shard.json).toMatchObject({
      ok: false,
      error: 'LITE_SERVER_UNKNOWN: block not found',
    });
  });

  it('runs each account at its own shard’s time (M2)', async () => {
    // The test wallet (0:cd…) is in the second shard, 9 s behind; RECIPIENT (0:11…) in the first.
    const s = setup('v4r2', { shards: 2, shardLagSeconds: 1, secondShardLagSeconds: 9 });
    s.node.fund(s.wallet, GRAM);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 5,
      deploy: true,
      messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
    });
    s.node.submit(boc);
    await s.clock.advance(6_000);
    // Masterchain time is past valid_until; the wallet's shard is not.
    s.node.mine();
    expect(s.node.seqno(s.wallet)).toBe(1);
    const mc = s.node.block(s.node.head)!.genUtime;
    expect(s.node.transactions()[0]?.now).toBe(mc - 9);
    s.node.mine();
    expect(s.node.transactions()[1]?.now).toBe(s.node.block(s.node.head)!.genUtime - 1);
  });

  it('names every trace after its root transaction (M3)', async () => {
    const s = setup('v4r2');
    s.node.inject(`0:${'22'.repeat(32)}`, RECIPIENT, GRAM, beginCell().endCell());
    s.node.mine();
    const [tx] = s.node.transactions();
    expect(tx?.traceId).toBe(tx?.hash);
    const traces = await get(`${s.v3}/traces?tx_hash=${tx!.hash}`, s.fetchFn);
    expect((traces.json.traces as Record<string, unknown>[])[0]).toMatchObject({
      trace_id: b64(tx!.hash),
      external_hash: null,
      is_incomplete: false,
    });
  });

  it('reports account statuses and the StateInit a message carries (M4)', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    const { boc } = await signedBoc('v4r2', TESTNET, {
      seqno: 0,
      validUntil: s.now() + 60,
      deploy: true,
      messages: [
        nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false }),
        nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
      ],
    });
    s.node.submit(boc);
    s.node.mine(3);
    const txs = async (account: string) =>
      (await get(`${s.v3}/transactions?account=${account}&limit=10`, s.fetchFn)).json
        .transactions as Record<string, unknown>[];
    const [back, root] = await txs(s.wallet);
    expect(root).toMatchObject({ orig_status: 'uninit', end_status: 'active' });
    const init = (root?.in_msg as { init_state: { hash: string; body: string } })
      .init_state;
    const stateInit = Cell.fromBoc(Buffer.from(init.body, 'base64'))[0]!;
    expect(init.hash).toBe(stateInit.hash().toString('base64'));
    expect(`0:${stateInit.hash().toString('hex')}`).toBe(s.wallet);
    expect(back).toMatchObject({ orig_status: 'active', end_status: 'active' });
    expect((back?.in_msg as Record<string, unknown>).init_state).toBeNull();
    expect((await txs(RECIPIENT))[0]).toMatchObject({
      orig_status: 'nonexist',
      end_status: 'uninit',
    });
    expect((await txs(FRESH))[0]).toMatchObject({
      orig_status: 'nonexist',
      end_status: 'nonexist',
    });
  });

  it('keys accounts by their canonical raw address, however a test spells them (M8)', () => {
    const s = setup('v4r2');
    const address = `0:${'ab'.repeat(32)}`;
    const friendly = Address.parseRaw(address).toString({
      testOnly: true,
      bounceable: false,
    });
    s.node.fund(friendly, GRAM);
    s.node.fund(address.toUpperCase(), GRAM);
    expect(s.node.balance(address)).toBe(2n * GRAM);
    expect(s.node.balance(friendly)).toBe(2n * GRAM);
    expect(s.node.jettonWalletOf(MASTER.toUpperCase(), friendly)).toBe(
      s.node.jettonWalletOf(MASTER, address),
    );
  });

  it.each([
    ['v4r2', 'expired', 36],
    ['v4r2', 'seqno', 33],
    ['v4r2', 'walletId', 34],
    ['v4r2', 'signature', 35],
    ['v5r1', 'signature', 135],
    ['v5r1', 'seqno', 133],
    ['v5r1', 'walletId', 134],
    ['v5r1', 'expired', 136],
  ] as const)(
    'refuses a %s request with a bad %s at send time (exitcode=%i)',
    async (version, fault, code) => {
      const s = setup(version);
      s.node.fund(s.wallet, GRAM);
      const good = {
        seqno: 0,
        validUntil: s.now() + 60,
        deploy: true,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
      };
      const boc =
        fault === 'walletId'
          ? await sdkRequest(version, { ...good, sendMode: SEND_MODE, subwallet: 1 })
          : (
              await signedBoc(version, TESTNET, {
                ...good,
                ...(fault === 'expired' ? { validUntil: s.now() } : {}),
                ...(fault === 'seqno' ? { seqno: 5 } : {}),
                ...(fault === 'signature' ? { seed: 'ab'.repeat(32) } : {}),
              })
            ).boc;
      const answer = await post(`${s.v2}/sendBocReturnHash`, { boc }, s.fetchFn);
      expect(answer.status).toBe(500);
      expect(String(answer.json.error)).toMatch(
        new RegExp(
          `: External message was not accepted: cannot run message on account: inbound external message rejected by transaction ${s.wallet.slice(2).toUpperCase()}:\\nexitcode=${code}, steps=\\d+, gas_used=0$`,
        ),
      );
      expect(s.node.pendingCount()).toBe(0);
    },
  );

  it('loses what swallow and dropPending lose, and re-checks the balance at inclusion', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, GRAM);
    const request = (validUntil: number) =>
      signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil,
        deploy: true,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
      });
    s.node.swallow = true;
    const swallowed = await request(s.now() + 60);
    const sent = await post(
      `${s.v2}/sendBocReturnHash`,
      { boc: swallowed.boc },
      s.fetchFn,
    );
    expect(sent.status).toBe(200);
    expect(s.node.sendCount(swallowed.hashNorm)).toBe(1);
    expect(s.node.pendingCount()).toBe(0);
    s.node.swallow = false;
    const dropped = await request(s.now() + 61);
    s.node.submit(dropped.boc);
    expect(s.node.pendingCount()).toBe(1);
    s.node.dropPending();
    expect(s.node.pendingCount()).toBe(0);
    s.node.mine();
    expect(s.node.transactions()).toHaveLength(0);
    // Accepted, then the balance is spent elsewhere: never included.
    const spent = await request(s.now() + 62);
    s.node.submit(spent.boc);
    s.node.debit(s.wallet, GRAM);
    s.node.mine();
    expect(s.node.transactions()).toHaveLength(0);
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.sendCount(spent.hashNorm)).toBe(1);
  });

  it('skips an internal message to a frozen account: a bounceable one bounces', async () => {
    const s = setup('v4r2');
    const sender = `0:${'22'.repeat(32)}`;
    s.node.fund(RECIPIENT, GRAM);
    s.node.freeze(RECIPIENT);
    s.node.inject(sender, RECIPIENT, GRAM, beginCell().endCell(), true);
    s.node.inject(sender, RECIPIENT, 5n, beginCell().endCell(), false);
    s.node.mine(2);
    const [bounced, kept] = s.node.transactions();
    for (const tx of [bounced, kept]) {
      expect(tx?.account).toBe(RECIPIENT);
      expect(tx?.origStatus).toBe('frozen');
      expect(tx?.endStatus).toBe('frozen');
      expect(tx?.description).toMatchObject({
        aborted: true,
        compute_ph: { skipped: true, reason: 'no_state' },
      });
    }
    expect(bounced?.description).toMatchObject({ bounce: { type: 'ok' } });
    expect(kept?.description).not.toHaveProperty('bounce');
    expect(s.node.balance(RECIPIENT)).toBe(GRAM + 5n);
    expect(s.node.status(RECIPIENT)).toBe('frozen');
  });

  it('leaves a jetton wallet deployed with no jettons after a refused internal_transfer', async () => {
    const s = setup('v4r2');
    s.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const genuine = s.node.jettonWalletOf(MASTER, RECIPIENT);
    const impostor = `0:${'66'.repeat(32)}`;
    s.node.deployFakeJettonWallet(impostor, MASTER, s.wallet, 1_000_000n);
    s.node.inject(impostor, genuine, 50_000_000n, internalTransfer(10n, s.wallet), true);
    s.node.mine(2);
    expect(s.node.status(genuine)).toBe('active');
    // Its owner's transfer finds no jettons: the balance error, and the value bounces.
    const transfer = jettonMessage({
      jettonWallet: genuine,
      attached: 50_000_000n,
      queryId: 0n,
      amount: 1n,
      destination: FRESH,
      responseDestination: RECIPIENT,
      forwardAmount: 0n,
    }).body;
    s.node.inject(RECIPIENT, genuine, 50_000_000n, transfer, true);
    s.node.mine(2);
    const refused = s.node.transactions().filter((t) => t.account === genuine)[1];
    expect(refused?.description).toMatchObject({
      aborted: true,
      compute_ph: { success: false, exit_code: 47 },
      bounce: { type: 'ok' },
    });
    expect(s.node.jettonBalance(MASTER, FRESH)).toBe(0n);
  });

  it('refuses an external the balance cannot import, and drains one it cannot run (chain texts)', async () => {
    const s = setup('v4r2');
    const request = (validUntil: number) =>
      signedBoc('v4r2', TESTNET, {
        seqno: 0,
        validUntil,
        deploy: true,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: false })],
      });
    // Below the import fee: refused before any code runs (transaction.cpp `unpack_input_msg`).
    s.node.fund(s.wallet, NODE_FEES.importFee - 1n);
    const answer = await post(
      `${s.v2}/sendBocReturnHash`,
      { boc: (await request(s.now() + 60)).boc },
      s.fetchFn,
    );
    expect(answer.status).toBe(500);
    expect(String(answer.json.error)).toBe(
      `LITE_SERVER_UNKNOWN: cannot apply external message to current state : External message was not accepted: cannot run message on account: inbound external message rejected by account ${s.wallet.slice(2).toUpperCase()} before smart-contract execution`,
    );
    // Enough to import and to accept, not to finish: the liteserver stops at the accept, and
    // the chain includes it out of gas (-14), taking the balance and keeping the seqno.
    s.node.fund(s.wallet, NODE_FEES.gasV4);
    const funded = s.node.balance(s.wallet);
    const sent = await post(
      `${s.v2}/sendBocReturnHash`,
      { boc: (await request(s.now() + 61)).boc },
      s.fetchFn,
    );
    expect(sent.status).toBe(200);
    s.node.mine(2);
    const [tx] = s.node.transactions();
    expect(tx?.description).toMatchObject({
      aborted: true,
      compute_ph: { skipped: false, success: false, exit_code: -14 },
    });
    expect(tx?.description).not.toHaveProperty('action');
    expect(tx?.totalFees).toBe(funded);
    expect(tx?.outMsgs).toHaveLength(0);
    expect(s.node.balance(s.wallet)).toBe(0n);
    expect(s.node.seqno(s.wallet)).toBe(0);
    expect(s.node.status(s.wallet)).toBe('active');
  });

  it('lets a test script a late answer, or one that never comes (intercept)', async () => {
    const t = tonNode();
    const info = { method: 'GET', path: '/getMasterchainInfo' } as const;
    const signals: (AbortSignal | undefined)[] = [];
    t.node.intercept = (_endpoint, route, _request, signal) => {
      if (route !== '/getMasterchainInfo') return undefined;
      signals.push(signal);
      return hang(signal);
    };
    // The transport gives up on each attempt and aborts it: the hanging answer ends.
    await expect(t.run(t.rpc.http(info))).rejects.toMatchObject({ retryable: true });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    // A late answer arrives once the clock moves.
    t.node.intercept = (_endpoint, route) =>
      route === '/getMasterchainInfo'
        ? t.clock.sleep(1_000).then(() => ({ json: { ok: true, result: 'late' } }))
        : undefined;
    await expect(t.run(t.rpc.http(info))).resolves.toEqual({ ok: true, result: 'late' });
    expect(t.node.served.at(-1)).toEqual({
      endpoint: 'main',
      route: '/getMasterchainInfo',
    });
  });
});

describe('the scripted toncenter node: the raw chain, deletion and re-deploy (F6-R21)', () => {
  const PAYER = `0:${'33'.repeat(32)}`;
  type RawRow = { data: string; transaction_id: { lt: string; hash: string } };

  /** The account's raw transactions from `(lt, hash)` back, through the v2 liteserver API. */
  async function rawChain(
    s: ReturnType<typeof setup>,
    lt: bigint,
    hash: string,
    limit = 16,
  ) {
    const query = new URLSearchParams({
      address: s.wallet,
      lt: lt.toString(),
      hash,
      limit: String(limit),
    });
    const answer = await get(`${s.v2}/getTransactions?${query.toString()}`, s.fetchFn);
    expect(answer.status).toBe(200);
    return (answer.json.result as RawRow[]).map((row) => {
      const cell = Cell.fromBoc(Buffer.from(row.data, 'base64'))[0]!;
      return { row, cell, tx: loadTransaction(cell.beginParse()) };
    });
  }

  const hex = (value: bigint) => value.toString(16).padStart(64, '0');

  /** A v4r2 request for the test key's wallet sending everything, then deleting it. */
  const destroy = (s: ReturnType<typeof setup>, seqno: number, mode = 128 + 32) =>
    v4Modes({
      seqno,
      validUntil: s.now() + 60,
      deploy: false,
      messages: [[mode, nativeMessage({ to: RECIPIENT, value: 0n, bounce: false })]],
    });

  const pay = (s: ReturnType<typeof setup>, seqno: number, deploy: boolean) =>
    v4Modes({
      seqno,
      validUntil: s.now() + 60,
      deploy,
      messages: [
        [SEND_MODE, nativeMessage({ to: RECIPIENT, value: GRAM, bounce: false })],
      ],
    });

  it('serves raw transaction cells hashed and linked as the chain links them', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    s.node.inject(PAYER, s.wallet, GRAM, beginCell().endCell());
    s.node.mine();
    s.node.submit(pay(s, 1, false));
    s.node.mine();
    const account = await get(
      `${s.v2}/getAddressInformation?address=${s.wallet}`,
      s.fetchFn,
    );
    const last = (
      account.json.result as { last_transaction_id: { lt: string; hash: string } }
    ).last_transaction_id;
    const lastHash = Buffer.from(last.hash, 'base64').toString('hex');
    const chain = await rawChain(s, BigInt(last.lt), lastHash);
    expect(chain).toHaveLength(3);
    // Each cell hashes to its id; each links to the one before; the first starts the chain.
    let expected = { lt: BigInt(last.lt), hash: lastHash };
    for (const { row, cell, tx } of chain) {
      expect(cell.hash().toString('hex')).toBe(expected.hash);
      expect(Buffer.from(row.transaction_id.hash, 'base64').toString('hex')).toBe(
        expected.hash,
      );
      expect(tx.lt).toBe(expected.lt);
      expect(hex(tx.address)).toBe(s.wallet.slice(2));
      expected = { lt: tx.prevTransactionLt, hash: hex(tx.prevTransactionHash) };
    }
    expect(expected).toEqual({ lt: 0n, hash: '0'.repeat(64) });
    // The indexer names each transaction by the same hash, with the chain's statuses.
    const v3 = s.node.transactions().filter((tx) => tx.account === s.wallet);
    expect(v3.map((tx) => tx.hash).reverse()).toEqual(
      chain.map(({ cell }) => cell.hash().toString('hex')),
    );
    expect(chain.map(({ tx }) => [tx.oldStatus, tx.endStatus]).reverse()).toEqual([
      ['uninitialized', 'active'],
      ['active', 'active'],
      ['active', 'active'],
    ]);
    const [newest, deposit] = chain;
    expect(newest?.tx.inMessage?.info.type).toBe('external-in');
    expect(deposit?.tx.inMessage?.info.type).toBe('internal');
    // A page starts where it is asked to, and a transaction it does not hold is refused.
    const rest = await rawChain(
      s,
      chain[1]!.tx.lt,
      chain[1]!.cell.hash().toString('hex'),
    );
    expect(rest).toHaveLength(2);
    const missing = await get(
      `${s.v2}/getTransactions?address=${s.wallet}&lt=1&hash=${'ab'.repeat(32)}&limit=4`,
      s.fetchFn,
    );
    expect(missing.status).toBe(500);
  });

  it('names the block and the last transaction in every get-method answer', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    s.node.submit(pay(s, 0, true));
    s.node.mine(2);
    const answer = await post(
      `${s.v2}/runGetMethod`,
      { address: s.wallet, method: 'seqno', stack: [], seqno: 2 },
      s.fetchFn,
    );
    const [tx] = s.node.transactions();
    expect(answer.json.result).toMatchObject({
      exit_code: 0,
      block_id: {
        workchain: -1,
        shard: '-9223372036854775808',
        seqno: 2,
        root_hash: Buffer.from(s.node.block(2)!.rootHash, 'hex').toString('base64'),
      },
      last_transaction_id: {
        lt: tx!.lt.toString(),
        hash: Buffer.from(tx!.hash, 'hex').toString('base64'),
      },
    });
  });

  it('sends the whole balance with +128, and deletes the account with +128+32', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    const before = s.node.balance(s.wallet);
    s.node.submit(destroy(s, 1, 128));
    s.node.mine(2);
    // +128 alone: everything leaves, the wallet stays (a zero-balance active account).
    expect(s.node.balance(s.wallet)).toBe(0n);
    expect(s.node.status(s.wallet)).toBe('active');
    expect(s.node.seqno(s.wallet)).toBe(2);
    expect(s.node.balance(RECIPIENT)).toBeGreaterThan(GRAM + before / 2n);
    s.node.inject(PAYER, s.wallet, GRAM, beginCell().endCell());
    s.node.mine();
    s.node.submit(destroy(s, 2));
    s.node.mine(2);
    // +128+32: transaction.cpp `acc_delete_req`, then the collator drops the account
    // (collator.cpp: `lookup_delete` from ShardAccounts), its last transaction included.
    expect(s.node.status(s.wallet)).toBe('uninitialized');
    expect(s.node.balance(s.wallet)).toBe(0n);
    expect(s.node.seqno(s.wallet)).toBe(0);
    const deleting = s.node
      .transactions()
      .filter((tx) => tx.account === s.wallet)
      .at(-1);
    expect(deleting).toMatchObject({ origStatus: 'active', endStatus: 'nonexist' });
    expect(deleting?.description).toMatchObject({
      aborted: false,
      destroyed: true,
      action: { success: true, status_change: 'deleted' },
    });
    const state = await get(
      `${s.v2}/getAddressInformation?address=${s.wallet}`,
      s.fetchFn,
    );
    expect(state.json.result).toMatchObject({
      state: 'uninitialized',
      balance: '0',
      last_transaction_id: { lt: '0', hash: Buffer.alloc(32).toString('base64') },
    });
    // A deleted wallet takes no external message: it cannot pay the import.
    expect(() => s.node.submit(pay(s, 3, false))).toThrow(
      /Failed to unpack account state/,
    );
  });

  it('re-deploys a deleted wallet by its StateInit: a new chain, from seqno 0', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    s.node.submit(destroy(s, 1));
    s.node.mine(2);
    s.node.inject(PAYER, s.wallet, 2n * GRAM, beginCell().endCell());
    s.node.mine();
    const refund = s.node
      .transactions()
      .filter((tx) => tx.account === s.wallet)
      .at(-1)!;
    expect(refund).toMatchObject({ origStatus: 'nonexist', endStatus: 'uninit' });
    const [first] = await rawChain(s, refund.lt, refund.hash, 1);
    // A re-created account starts a new chain (transaction.cpp `init_new`).
    expect(first?.tx.prevTransactionLt).toBe(0n);
    expect(first?.tx.prevTransactionHash).toBe(0n);
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    expect(s.node.status(s.wallet)).toBe('active');
    expect(s.node.seqno(s.wallet)).toBe(1);
  });

  it('leaves a non-existing account without a chain when a delivery to it bounces (N3)', async () => {
    const s = setup('v4r2');
    const nowhere = `0:${'44'.repeat(32)}`;
    s.node.inject(PAYER, nowhere, GRAM, beginCell().endCell(), true);
    s.node.mine(2);
    const [bounced] = s.node.transactions().filter((tx) => tx.account === nowhere);
    expect(bounced).toMatchObject({ origStatus: 'nonexist', endStatus: 'nonexist' });
    expect(bounced?.description).toMatchObject({ bounce: { type: 'ok' } });
    // transaction.cpp `compute_state`: uninit, not activated, zero balance → account_none,
    // which the collator never stores: no last transaction.
    const state = await get(
      `${s.v2}/getAddressInformation?address=${nowhere}`,
      s.fetchFn,
    );
    expect(state.json.result).toMatchObject({
      balance: '0',
      last_transaction_id: { lt: '0', hash: Buffer.alloc(32).toString('base64') },
    });
    s.node.inject(PAYER, nowhere, GRAM, beginCell().endCell());
    s.node.mine();
    const deposit = s.node.transactions().filter((tx) => tx.account === nowhere)[1];
    expect(deposit).toMatchObject({ prevLt: 0n, prevHash: '0'.repeat(64) });
  });

  it('leaves the account uninitialized, in the same chain, when it holds an extra currency', async () => {
    const s = setup('v4r2');
    s.node.fund(s.wallet, 3n * GRAM);
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    s.node.holdExtraCurrency(s.wallet);
    s.node.submit(destroy(s, 1));
    s.node.mine(2);
    // transaction.cpp: `acc_status = remaining_balance.is_zero() ? acc_deleted : acc_uninit`.
    expect(s.node.status(s.wallet)).toBe('uninitialized');
    const [destroying] = s.node
      .transactions()
      .filter((tx) => tx.account === s.wallet)
      .slice(-1);
    expect(destroying).toMatchObject({ origStatus: 'active', endStatus: 'uninit' });
    const state = await get(
      `${s.v2}/getAddressInformation?address=${s.wallet}`,
      s.fetchFn,
    );
    const last = (state.json.result as { last_transaction_id: { lt: string } })
      .last_transaction_id;
    expect(last.lt).toBe(destroying!.lt.toString());
    s.node.inject(PAYER, s.wallet, 2n * GRAM, beginCell().endCell());
    s.node.mine();
    s.node.submit(pay(s, 0, true));
    s.node.mine();
    expect(s.node.seqno(s.wallet)).toBe(1);
    const newest = s.node
      .transactions()
      .filter((tx) => tx.account === s.wallet)
      .at(-1)!;
    const chain = await rawChain(s, newest.lt, newest.hash);
    // One chain: the re-deploy, the refund, the destroying request, the first deploy.
    expect(chain.map(({ tx }) => [tx.oldStatus, tx.endStatus])).toEqual([
      ['uninitialized', 'active'],
      ['uninitialized', 'uninitialized'],
      ['active', 'uninitialized'],
      ['uninitialized', 'active'],
    ]);
  });
});
