import { sha256 } from '@noble/hashes/sha256';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { tronwebCodec } from '../../../src/adapters/tron/codec';
import type { TronRawData } from '../../../src/adapters/tron/types';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { parseJson } from '../../../src/core/util/json';
import { NEW_HOLDER_ENERGY, ScriptedTronNode, TRANSFER_ENERGY } from './support/node';
import { encodeRawData, encodeTransaction } from './support/protobuf';
import { signTxId, signedTransaction } from './support/signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
} from './support/vectors';

const TRX = 1_000_000n;

function setup() {
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedTronNode({ clock, solidDepth: 3 });
  const url = node.endpoint('main');
  const post = async (path: string, body: unknown = {}) =>
    (
      await node.fetch.fetch(`${url}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    ).json() as Promise<Record<string, unknown>>;
  const ref = () => {
    const block = node.block(node.head) as { id: string; timestamp: number };
    return {
      refBlockBytes: block.id.slice(12, 16),
      refBlockHash: block.id.slice(16, 32),
      expiration: block.timestamp + 60_000,
      timestamp: block.timestamp,
    };
  };
  const trx = (amount: bigint, extra: Partial<TronRawData> = {}): TronRawData => ({
    ...ref(),
    contract: { type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount },
    ...extra,
  });
  const send = (raw: TronRawData) =>
    post('/wallet/broadcasthex', { transaction: signedTransaction(raw).hex });
  return { clock, node, url, post, ref, trx, send };
}

describe('ScriptedTronNode', () => {
  it('serves block 0 as the network identity and mines 3-second slots', async () => {
    const { node, post, clock } = setup();
    const genesis = await post('/wallet/getblockbynum', { num: 0 });
    expect(genesis.blockID).toBe(
      '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
    );
    node.mine();
    await clock.advance(10_000);
    node.mine();
    const b1 = node.block(1);
    const b2 = node.block(2);
    expect((b2?.timestamp ?? 0) - (b1?.timestamp ?? 0)).toBeGreaterThanOrEqual(3000);
    expect((b2?.timestamp ?? 0) % 3000).toBe(0);
  });

  it('admits a transfer, charges activation and memo fees, and executes it in a block', async () => {
    const { node, send, trx, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const answer = await send(trx(2n * TRX, { data: '6869' }));
    expect(answer).toMatchObject({ result: true });
    node.mine();
    // 2 TRX + 1 TRX account creation + 0.1 TRX creation bandwidth + 1 TRX memo
    expect(node.balance(RECIPIENT)).toBe(2n * TRX);
    expect(node.balance(KEY_ADDRESS)).toBe(10n * TRX - 2n * TRX - 2_100_000n);
    const info = await post('/wallet/gettransactioninfobyid', { value: answer.txid });
    expect(info).toMatchObject({
      fee: 2_100_000,
      blockNumber: 1,
      receipt: { net_fee: 100_000 },
    });
  });

  it('refuses what java-tron refuses, with its codes and texts', async () => {
    const { node, send, trx, ref, clock } = setup();
    expect(await send(trx(1n))).toMatchObject({
      code: 'CONTRACT_VALIDATE_ERROR',
      message: expect.stringMatching(/no OwnerAccount/),
    });
    node.fund(KEY_ADDRESS, TRX);
    node.fund(RECIPIENT, 1n);
    expect(await send(trx(5n * TRX))).toMatchObject({
      message: expect.stringMatching(/balance is not sufficient/),
    });
    expect(
      await send({
        ...trx(1n),
        contract: { type: 'TransferContract', owner: KEY_HEX, to: KEY_HEX, amount: 1n },
      }),
    ).toMatchObject({
      message: 'Contract validate error : Cannot transfer TRX to yourself.',
    });
    expect(await send(trx(1n, { refBlockHash: '00'.repeat(8) }))).toMatchObject({
      code: 'TAPOS_ERROR',
    });
    expect(await send(trx(1n, { expiration: ref().timestamp }))).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
    });
    const ok = trx(1n);
    expect(await send(ok)).toMatchObject({ result: true });
    expect(await send(ok)).toMatchObject({ code: 'DUP_TRANSACTION_ERROR' });
    void clock;
  });

  it('drops a pooled transaction once its expiration is at or before the parent block', async () => {
    const { node, send, trx, clock } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const raw = trx(TRX);
    const { txid } = (await send(raw)) as { txid: string };
    await clock.advance(60_000);
    node.mine({ include: false });
    node.mine();
    expect(node.transaction(txid)).toBeUndefined();
    expect(node.inPool(txid)).toBe(false);
  });

  it('caps TRC-20 energy at the fee limit: a low limit is included and fails OUT_OF_ENERGY', async () => {
    const { node, send, ref, post } = setup();
    node.fund(KEY_ADDRESS, 100n * TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    const data = `a9059cbb${RECIPIENT_HEX.slice(2).padStart(64, '0')}${10n.toString(16).padStart(64, '0')}`;
    const call = (feeLimit: number): TronRawData => ({
      ...ref(),
      feeLimit,
      contract: {
        type: 'TriggerSmartContract',
        owner: KEY_HEX,
        contract: USDT_HEX,
        data,
      },
    });
    const need = Number((TRANSFER_ENERGY + NEW_HOLDER_ENERGY) * 100n);
    const low = (await send(call(need - 100))) as { txid: string };
    node.mine();
    expect(
      await post('/wallet/gettransactioninfobyid', { value: low.txid }),
    ).toMatchObject({
      result: 'FAILED',
      receipt: { result: 'OUT_OF_ENERGY' },
    });
    expect(node.tokenBalance(USDT, RECIPIENT)).toBe(0n);
    const ok = (await send({ ...call(need), timestamp: ref().timestamp + 1 })) as {
      txid: string;
    };
    node.mine();
    const info = await post('/wallet/gettransactioninfobyid', { value: ok.txid });
    expect(info).toMatchObject({
      receipt: { result: 'SUCCESS' },
      log: [expect.objectContaining({ address: USDT_HEX.slice(2) })],
    });
    expect(node.tokenBalance(USDT, RECIPIENT)).toBe(10n);
  });

  it('serves solidified views, lagging endpoints and JSON-RPC block reads', async () => {
    const { node, url, post } = setup();
    const lagging = node.endpoint('slow');
    for (let i = 0; i < 6; i++) node.mine();
    const solid = await post('/walletsolidity/getblock', { detail: false });
    expect((solid.block_header as { raw_data: { number: number } }).raw_data.number).toBe(
      3,
    );
    expect(
      await post('/walletsolidity/getblock', { id_or_num: '4', detail: false }),
    ).toEqual({});
    node.lag('slow', 2);
    const slow = (await (
      await node.fetch.fetch(`${lagging}/wallet/getblock`, { method: 'POST', body: '{}' })
    ).json()) as { block_header: { raw_data: { number: number } } };
    expect(slow.block_header.raw_data.number).toBe(4);
    const rpc = (await (
      await node.fetch.fetch(`${url}/jsonrpc`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBlockByNumber',
          params: ['0x2', false],
        }),
      })
    ).json()) as { result: unknown };
    expect(rpc.result).toMatchObject({ number: '0x2', hash: `0x${node.block(2)?.id}` });
  });

  it('reorgs unsolidified blocks only and returns their transactions to the pool', async () => {
    const { node, send, trx } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    for (let i = 0; i < 4; i++) node.mine();
    const { txid } = (await send(trx(TRX))) as { txid: string };
    node.mine();
    const before = node.block(5)?.id;
    node.reorg(1);
    expect(node.block(5)?.id).not.toBe(before);
    expect(node.inPool(txid)).toBe(true);
    expect(() => node.reorg(4)).toThrow('reorg too deep');
  });

  it('drives with the fake clock only', async () => {
    const { clock, post } = setup();
    await expect(
      drive(clock, post('/wallet/getchainparameters')),
    ).resolves.toHaveProperty('chainParameter');
    expect(clock.pending).toBe(0);
  });

  it('activates only through a positive transfer, and refuses in a block an expiration before the next slot', async () => {
    const { node, send, trx, clock } = setup();
    expect(() => node.fund(KEY_ADDRESS, 0n)).toThrow('fund needs a positive amount');
    expect(node.exists(KEY_ADDRESS)).toBe(false);
    node.fund(KEY_ADDRESS, 10n * TRX);
    const head = node.block(node.head) as { id: string; timestamp: number };
    // Valid against the head at admission, but less than one slot past it.
    const { txid } = (await send(trx(TRX, { expiration: head.timestamp + 1_000 }))) as {
      txid: string;
    };
    expect(node.inPool(txid)).toBe(true);
    await clock.advance(3_000);
    node.mine();
    expect(node.transaction(txid)).toBeUndefined();
  });

  it('pins the admission edges: signature size and owner, the 24-hour window, the size cap', async () => {
    const { node, send, trx, ref, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const raw = trx(1n);
    const { hex, id } = signedTransaction(raw);
    const rawHex = encodeRawData(raw);
    const short = encodeTransaction(rawHex, [signTxId(id).slice(0, 128)]);
    expect(await post('/wallet/broadcasthex', { transaction: short })).toMatchObject({
      result: false,
      code: 'SIGERROR',
      message: 'Validate signature error: Signature size is 64',
    });
    const other = signedTransaction(raw, '11'.repeat(32)).hex;
    expect(await post('/wallet/broadcasthex', { transaction: other })).toMatchObject({
      code: 'SIGERROR',
      message: `Validate signature error: ${id} sig error`,
    });
    expect(await post('/wallet/broadcasthex', { transaction: hex })).toMatchObject({
      result: true,
      txid: id,
    });
    const day = ref().timestamp + 86_400_000;
    expect(await send(trx(2n, { expiration: day + 1 }))).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
    });
    expect(await send(trx(2n, { expiration: day }))).toMatchObject({ result: true });
    expect(await send(trx(3n, { data: '00'.repeat(512_000) }))).toMatchObject({
      code: 'TOO_BIG_TRANSACTION_ERROR',
    });
  });

  it('writes integers exactly, so amounts above 2^53 reach an exactIntegers parse unrounded', async () => {
    const { node, url, send, trx } = setup();
    const funded = 2n ** 60n + 1n;
    const amount = 2n ** 53n + 1n;
    node.fund(KEY_ADDRESS, funded);
    const text = async (path: string, body: unknown) =>
      (
        await node.fetch.fetch(`${url}${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).text();
    const account = await text('/wallet/getaccount', { address: KEY_HEX });
    expect(account).toContain(`"balance":${funded}`);
    expect(parseJson(account, true)).toMatchObject({ balance: funded });
    const { txid } = (await send(trx(amount))) as { txid: string };
    node.mine();
    const served = await text('/wallet/gettransactionbyid', { value: txid });
    expect(served).toContain(`"amount":${amount}`);
    const tx = parseJson(served, true) as { raw_data_hex: string };
    expect(tronwebCodec.readRaw(tx.raw_data_hex)?.contract).toMatchObject({ amount });
  });

  it('admits what the real codec encodes and serves raw data the real codec reads', async () => {
    const { node, ref, post } = setup();
    node.fund(KEY_ADDRESS, 100n * TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    const raws: TronRawData[] = [
      {
        ...ref(),
        data: '6869',
        contract: {
          type: 'TransferContract',
          owner: KEY_HEX,
          to: RECIPIENT_HEX,
          amount: TRX,
        },
      },
      {
        ...ref(),
        feeLimit: 30_000_000,
        contract: {
          type: 'TriggerSmartContract',
          owner: KEY_HEX,
          contract: USDT_HEX,
          data: `a9059cbb${RECIPIENT_HEX.slice(2).padStart(64, '0')}${'0a'.padStart(64, '0')}`,
        },
      },
    ];
    const ids: string[] = [];
    for (const raw of raws) {
      const rawHex = tronwebCodec.encodeRaw(raw);
      const id = toHex(sha256(fromHex(rawHex)));
      const answer = await post('/wallet/broadcasthex', {
        transaction: encodeTransaction(rawHex, [signTxId(id)]),
      });
      expect(answer).toMatchObject({ result: true, txid: id });
      ids.push(id);
    }
    node.mine();
    for (const [i, id] of ids.entries()) {
      const served = await post('/wallet/gettransactionbyid', { value: id });
      expect(served).toMatchObject({ txID: id, ret: [{ contractRet: 'SUCCESS' }] });
      const rawHex = served.raw_data_hex as string;
      expect(toHex(sha256(fromHex(rawHex)))).toBe(id);
      expect(tronwebCodec.decodeRaw(rawHex)).toEqual(raws[i]);
      expect(tronwebCodec.readRaw(rawHex)).toEqual(raws[i]);
    }
  });

  it('reverts every change of a transaction a block refuses', async () => {
    const { node, send, trx, post } = setup();
    node.fund(KEY_ADDRESS, TRX);
    node.fund(RECIPIENT, 1n);
    const genesis = node.block(0) as { id: string; timestamp: number };
    node.mine();
    // Funds that exist only in block 1, which the reorg below discards.
    node.fund(KEY_ADDRESS, 10n * TRX);
    const { txid } = (await send(
      trx(5n * TRX, {
        refBlockBytes: genesis.id.slice(12, 16),
        refBlockHash: genesis.id.slice(16, 32),
      }),
    )) as { txid: string };
    node.reorg(1);
    expect(node.inPool(txid)).toBe(true);
    node.mine();
    // Refused in block 2 (the balance is 1 TRX again) after its free bandwidth was counted.
    expect(node.transaction(txid)).toBeUndefined();
    expect(node.inPool(txid)).toBe(false);
    expect(node.balance(KEY_ADDRESS)).toBe(TRX);
    const resources = await post('/wallet/getaccountresource', { address: KEY_HEX });
    expect(resources).not.toHaveProperty('freeNetUsed');
  });
});
