import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { hang } from '../../../src/testing/fake-fetch';
import { addressFromPublicKey, toHexAddress } from '../../../src/adapters/tron/address';
import { tronwebCodec } from '../../../src/adapters/tron/codec';
import type { TronRawData } from '../../../src/adapters/tron/types';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { parseJson } from '../../../src/core/util/json';
import {
  GENESIS,
  NEW_HOLDER_ENERGY,
  ScriptedTronNode,
  TRANSFER_ENERGY,
  encodeWireRaw,
  encodeWireTransaction,
  type WireExtras,
} from './support/node';
import { encodeRawData, encodeTransaction } from './support/protobuf';
import { signRawHex, signTxId, signedTransaction } from './support/signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
  VECTORS,
} from './support/vectors';

const TRX = 1_000_000n;
const OTHER_KEY = '22'.repeat(32);
const OTHER = addressFromPublicKey(secp256k1.getPublicKey(OTHER_KEY, true));
const OTHER_HEX = toHexAddress(OTHER);
const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const TRANSFER_DATA = `a9059cbb${word(BigInt(`0x${RECIPIENT_HEX.slice(2)}`))}${word(10n)}`;
const idOf = (rawHex: string): string => toHex(sha256(fromHex(rawHex)));
/** A minimal protobuf varint, hex. */
function varintHex(value: bigint): string {
  let v = value;
  let out = '';
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out += byte.toString(16).padStart(2, '0');
  } while (v > 0n);
  return out;
}

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
  const get = async (path: string) =>
    (await (await node.fetch.fetch(`${url}${path}`)).json()) as {
      data: Record<string, unknown>[];
      meta: { fingerprint?: string };
    };
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
  const call = (feeLimit: number, extra: Partial<TronRawData> = {}): TronRawData => ({
    ...ref(),
    feeLimit,
    contract: {
      type: 'TriggerSmartContract',
      owner: KEY_HEX,
      contract: USDT_HEX,
      data: TRANSFER_DATA,
    },
    ...extra,
  });
  const broadcast = (hex: string) => post('/wallet/broadcasthex', { transaction: hex });
  const send = (raw: TronRawData) => broadcast(signedTransaction(raw).hex);
  const sendWire = (raw: TronRawData, extras: WireExtras, key?: string) =>
    broadcast(signRawHex(encodeWireRaw(raw, extras), key).hex);
  return { clock, node, url, post, get, ref, trx, call, broadcast, send, sendWire };
}

/** A memo length that gives `raw` exactly `target` bytes under `measure` (signed size). */
function memoFor(
  target: number,
  raw: (memo: string) => TronRawData,
  measure: (signedBytes: number) => number,
): TronRawData {
  let length = target;
  for (let i = 0; i < 6; i++) {
    const candidate = raw('00'.repeat(length));
    const size = measure(signedTransaction(candidate).hex.length / 2);
    if (size === target) return candidate;
    length += target - size;
  }
  throw new Error('no memo length gives that size');
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
    const { node, send, trx, ref } = setup();
    // Fix round 1: BandwidthProcessor.consume refuses a missing owner before
    // TransferActuator.validate (whose "no OwnerAccount" the brief expected here).
    expect(await send(trx(1n))).toMatchObject({
      code: 'CONTRACT_VALIDATE_ERROR',
      message: `Contract validate error : account [${KEY_ADDRESS}] does not exist`,
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

  it('activates only through a positive transfer, and refuses an expiration before the next slot at admission and in a block', async () => {
    const { node, send, trx } = setup();
    expect(() => node.fund(KEY_ADDRESS, 0n)).toThrow('fund needs a positive amount');
    expect(node.exists(KEY_ADDRESS)).toBe(false);
    node.fund(KEY_ADDRESS, 10n * TRX);
    const head = node.block(node.head) as { id: string; timestamp: number };
    // Fix round 1: Wallet.broadcastTransaction checks the expiration against the next slot
    // before admission, so the brief's head + 1 s is refused here.
    expect(await send(trx(TRX, { expiration: head.timestamp + 2_999 }))).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
      message: 'Transaction expired',
    });
    // Valid at admission, but less than one slot past the parent of the block after next.
    const { txid } = (await send(trx(TRX, { expiration: head.timestamp + 4_000 }))) as {
      txid: string;
    };
    expect(node.inPool(txid)).toBe(true);
    node.mine({ include: false });
    expect(node.inPool(txid)).toBe(true);
    node.mine();
    expect(node.transaction(txid)).toBeUndefined();
    expect(node.inPool(txid)).toBe(false);
  });

  it('pins the admission edges: signature size, the next slot and the 24-hour window', async () => {
    const { node, send, trx, ref, broadcast } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const raw = trx(1n);
    const { hex, id } = signedTransaction(raw);
    const rawHex = encodeRawData(raw);
    expect(
      await broadcast(encodeTransaction(rawHex, [signTxId(id).slice(0, 128)])),
    ).toMatchObject({
      result: false,
      code: 'SIGERROR',
      message: 'Validate signature error: Signature size is 64',
    });
    expect(
      await broadcast(encodeTransaction(rawHex, [`${signTxId(id)}${'00'.repeat(4)}`])),
    ).toMatchObject({
      code: 'SIGERROR',
      message: 'Validate signature error: Signature size is 69',
    });
    expect(await broadcast(hex)).toMatchObject({ result: true, txid: id });
    const slot = ref().timestamp + 3_000;
    expect(await send(trx(2n, { expiration: slot - 1 }))).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
    });
    expect(await send(trx(2n, { expiration: slot }))).toMatchObject({ result: true });
    const day = ref().timestamp + 86_400_000;
    expect(await send(trx(3n, { expiration: day + 1 }))).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
    });
    expect(await send(trx(3n, { expiration: day }))).toMatchObject({ result: true });
  });

  it("checks the signature first, against the one owner key, with java-tron's texts", async () => {
    const { trx, broadcast } = setup();
    const raw = trx(1n);
    const rawHex = encodeRawData(raw);
    const id = toHex(sha256(fromHex(rawHex)));
    // (c) TransactionCapsule.validatePubSignature and checkWeight (one owner key).
    const signed = (count: number) =>
      encodeTransaction(
        rawHex,
        Array.from({ length: count }, (_, i) =>
          signTxId(id, i === 0 ? undefined : OTHER_KEY),
        ),
      );
    expect(await broadcast(signed(0))).toMatchObject({
      code: 'SIGERROR',
      message: 'Validate signature error: miss sig or contract',
    });
    expect(await broadcast(signed(2))).toMatchObject({
      code: 'SIGERROR',
      message:
        'Validate signature error: Signature count is 2 more than key counts of permission : 1',
    });
    expect(await broadcast(signed(6))).toMatchObject({
      code: 'SIGERROR',
      message: 'Validate signature error: too many signatures',
    });
    // (e) checkWeight: a key outside the owner permission.
    expect(await broadcast(signedTransaction(raw, OTHER_KEY).hex)).toMatchObject({
      code: 'SIGERROR',
      message: `Validate signature error: ${id} is signed by ${OTHER} but it is not contained of permission.`,
    });
    // The signature is checked before TaPoS (Manager.pushTransaction).
    expect(
      await broadcast(
        signedTransaction({ ...raw, refBlockHash: '00'.repeat(8) }, OTHER_KEY).hex,
      ),
    ).toMatchObject({ code: 'SIGERROR' });
  });

  it('refuses a recipient that is not a 21-byte 41… address, and TRX into a contract', async () => {
    const { node, send, trx } = setup();
    // TransferActuator.validate, after the account-creation bandwidth is paid.
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    const to = (address: string) =>
      trx(1n, {
        contract: { type: 'TransferContract', owner: KEY_HEX, to: address, amount: 1n },
      });
    for (const bad of ['41' + '55'.repeat(19), '42' + '55'.repeat(20), '']) {
      expect(await send(to(bad))).toMatchObject({
        code: 'CONTRACT_VALIDATE_ERROR',
        message: 'Contract validate error : Invalid toAddress!',
      });
    }
    expect(await send(to(USDT_HEX))).toMatchObject({
      message: 'Contract validate error : Cannot transfer TRX to a smartContract.',
    });
  });

  it("charges the memo fee after bandwidth, and checks a call's contract before its fee limit", async () => {
    const { node, send, trx, call } = setup();
    // (b) Manager.consumeMemoFee: a balance below the memo fee.
    node.fund(KEY_ADDRESS, 500_000n);
    node.fund(RECIPIENT, 1n);
    expect(await send(trx(1n, { data: '6869' }))).toMatchObject({
      code: 'BANDWITH_ERROR',
      message: 'Account resource insufficient error.',
    });
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    // VMActuator.call: the contract first, then the fee limit.
    const tooHigh = 20_000_000_000;
    const notAContract = call(tooHigh, {
      contract: {
        type: 'TriggerSmartContract',
        owner: KEY_HEX,
        contract: RECIPIENT_HEX,
        data: TRANSFER_DATA,
      },
    });
    expect(await send(notAContract)).toMatchObject({
      code: 'CONTRACT_VALIDATE_ERROR',
      message: 'Contract validate error : No contract or not a smart contract',
    });
    expect(await send(call(tooHigh))).toMatchObject({
      message: 'Contract validate error : feeLimit must be >= 0 and <= 15000000000',
    });
  });

  it("answers broadcasthex with java-tron's full envelope, or an Error for bytes it cannot parse", async () => {
    const { node, send, trx, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const raw = trx(1n, { data: '6869' });
    const { id } = signedTransaction(raw);
    const ok = await send(raw);
    expect(Object.keys(ok).sort()).toEqual([
      'code',
      'message',
      'result',
      'transaction',
      'txid',
    ]);
    expect(ok).toMatchObject({ result: true, code: 'SUCCESS', message: '', txid: id });
    expect(JSON.parse(ok.transaction as string)).toEqual({
      raw_data: {
        ref_block_bytes: raw.refBlockBytes,
        ref_block_hash: raw.refBlockHash,
        expiration: raw.expiration,
        data: '6869',
        contract: [
          {
            type: 'TransferContract',
            parameter: {
              type_url: 'type.googleapis.com/protocol.TransferContract',
              value: expect.stringMatching(
                /^0a15412c7536e3605d9c16a7a3d7b1898e529396a65c23/,
              ),
            },
          },
        ],
        timestamp: raw.timestamp,
      },
      signature: [signTxId(id)],
    });
    const refused = await send(raw);
    expect(Object.keys(refused).sort()).toEqual([
      'code',
      'message',
      'result',
      'transaction',
      'txid',
    ]);
    expect(refused).toMatchObject({
      result: false,
      code: 'DUP_TRANSACTION_ERROR',
      txid: id,
    });
    const junk = await post('/wallet/broadcasthex', { transaction: 'zz' });
    expect(junk).not.toHaveProperty('result');
    expect(junk.Error).toMatch(/^class /);
  });

  it('serves block 0 as java-tron builds it: no number, timestamp, version or witness signature', async () => {
    const { node, url, post } = setup();
    node.mine();
    const genesis = [
      await post('/wallet/getblockbynum', { num: 0 }),
      await post('/walletsolidity/getblockbynum', { num: 0 }),
      await post('/wallet/getblock', { id_or_num: '0', detail: false }),
    ];
    for (const block of genesis) {
      expect(block.blockID).toBe(GENESIS.nile);
      const header = block.block_header as { raw_data: Record<string, unknown> };
      // Fix round 2: proto3 JSON drops block 0's zero timestamp too (the brief kept it).
      for (const key of ['number', 'timestamp', 'version']) {
        expect(header.raw_data).not.toHaveProperty(key);
      }
      expect(header).not.toHaveProperty('witness_signature');
    }
    expect(await post('/wallet/getblockbynum', { num: 1 })).toMatchObject({
      block_header: {
        raw_data: { number: 1, version: 32, timestamp: node.block(1)?.timestamp },
        witness_signature: expect.any(String),
      },
    });
    const rpc = (await (
      await node.fetch.fetch(`${url}/jsonrpc`, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          method: 'eth_getBlockByNumber',
          params: ['0x0', false],
        }),
      })
    ).json()) as { result: { timestamp: string } };
    expect(rpc.result.timestamp).toBe('0x0');
    // The node's own rules keep block 0's slot time.
    expect(node.block(0)?.timestamp).toBeGreaterThan(0);
  });

  it('serves /v1 history from the head by default, solidified only when confirmed, at most 200 a page', async () => {
    const { node, send, trx, get } = setup();
    node.fund(KEY_ADDRESS, 100n * TRX);
    node.fund(RECIPIENT, 1n);
    const ids: string[] = [];
    for (let i = 1n; i <= 201n; i++) {
      ids.push(((await send(trx(i))) as { txid: string }).txid);
    }
    node.mine();
    const path = `/v1/accounts/${KEY_ADDRESS}/transactions`;
    const first = await get(`${path}?limit=500`);
    expect(first.data).toHaveLength(200);
    expect(first.meta.fingerprint).toBe('200');
    const rest = await get(`${path}?limit=500&fingerprint=200`);
    expect(rest.data.map((t) => t.txID)).toEqual([ids[0]]);
    expect((await get(`${path}?only_confirmed=true`)).data).toEqual([]);
    for (let i = 0; i < 3; i++) node.mine();
    expect((await get(`${path}?only_confirmed=true&limit=1`)).data).toHaveLength(1);
  });

  it('models a TRX call value: refused beyond the balance, spent from the energy budget, reverted by a non-payable token, and served', async () => {
    const { node, call, sendWire, post } = setup();
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    node.fund(KEY_ADDRESS, 3n * TRX);
    // Staked bandwidth, so that no bandwidth fee moves the balance below.
    node.stake(KEY_ADDRESS, { bandwidth: 10_000n });
    // MUtil.transfer during validation: the value must be covered.
    expect(await sendWire(call(10_000_000), { callValue: 5n * TRX })).toMatchObject({
      code: 'CONTRACT_VALIDATE_ERROR',
      message:
        'Contract validate error : Validate InternalTransfer error, balance is not sufficient.',
    });
    expect(await sendWire(call(10_000_000), { callValue: -1n })).toMatchObject({
      message: 'Contract validate error : callValue must be >= 0',
    });
    // Covered: admitted, then the token's non-payable function reverts and keeps nothing.
    const reverted = (await sendWire(call(10_000_000), { callValue: 2n * TRX })) as {
      txid: string;
    };
    expect(reverted).toMatchObject({ result: true });
    node.mine();
    expect(
      await post('/wallet/gettransactioninfobyid', { value: reverted.txid }),
    ).toMatchObject({ result: 'FAILED', receipt: { result: 'REVERT' } });
    const burned = 3n * TRX - node.balance(KEY_ADDRESS);
    expect(burned).toBeGreaterThan(0n);
    expect(burned).toBeLessThan(TRX);
    const served = await post('/wallet/gettransactionbyid', { value: reverted.txid });
    expect(served).toMatchObject({
      raw_data: {
        contract: [
          { parameter: { value: { call_value: 2_000_000, data: TRANSFER_DATA } } },
        ],
      },
    });
    // VMActuator: the energy budget is (balance − value) / price, so a value that leaves
    // 5,000 sun buys 50 energy, too little for the revert: OUT_OF_ENERGY.
    const left = node.balance(KEY_ADDRESS);
    const starved = (await sendWire(call(10_000_000, { timestamp: 7 }), {
      callValue: left - 5_000n,
    })) as { txid: string };
    node.mine();
    expect(
      await post('/wallet/gettransactioninfobyid', { value: starved.txid }),
    ).toMatchObject({ receipt: { result: 'OUT_OF_ENERGY' } });
  });

  it('places a foreign transaction in a block as is, with every signature', async () => {
    const { node, ref, post, get } = setup();
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    const raw: TronRawData = {
      ...ref(),
      feeLimit: 1_000_000,
      contract: {
        type: 'TriggerSmartContract',
        owner: OTHER_HEX,
        contract: USDT_HEX,
        data: 'abcd',
      },
    };
    const rawHex = encodeWireRaw(raw, { callValue: 7n });
    const id = toHex(sha256(fromHex(rawHex)));
    const sigs = [signTxId(id, OTHER_KEY), signTxId(id)];
    expect(node.place(encodeTransaction(rawHex, sigs))).toBe(id);
    const reverted = signRawHex(
      encodeWireRaw({ ...raw, timestamp: 1 }, { callValue: 7n }),
      OTHER_KEY,
    );
    expect(node.place(reverted.hex, 'REVERT')).toBe(reverted.id);
    expect(() => node.place(reverted.hex)).toThrow();
    node.mine();
    expect(await post('/wallet/gettransactionbyid', { value: id })).toMatchObject({
      txID: id,
      ret: [{ contractRet: 'SUCCESS' }],
      signature: sigs,
      raw_data_hex: rawHex,
      raw_data: { contract: [{ parameter: { value: { call_value: 7 } } }] },
    });
    expect(
      await post('/wallet/gettransactioninfobyid', { value: reverted.id }),
    ).toMatchObject({ result: 'FAILED', receipt: { result: 'REVERT' } });
    const block = await post('/wallet/getblock', { id_or_num: '1', detail: true });
    expect((block.transactions as { txID: string }[]).map((t) => t.txID)).toEqual([
      id,
      reverted.id,
    ]);
    expect((await get(`/v1/accounts/${OTHER}/transactions`)).data).toHaveLength(2);
  });

  it('serves solidified state on /walletsolidity, and neither broadcast nor pool there', async () => {
    const { node, url, post } = setup();
    node.fund(KEY_ADDRESS, TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 5n);
    node.mine();
    node.fund(KEY_ADDRESS, TRX);
    node.mintToken(USDT, KEY_ADDRESS, 5n);
    node.stake(KEY_ADDRESS, { energy: 7n });
    const account = { address: KEY_HEX };
    expect(await post('/wallet/getaccount', account)).toMatchObject({
      balance: 2_000_000,
    });
    expect(await post('/walletsolidity/getaccount', account)).toMatchObject({
      balance: 1_000_000,
    });
    expect(await post('/wallet/getaccountresource', account)).toMatchObject({
      EnergyLimit: 7,
    });
    expect(await post('/walletsolidity/getaccountresource', account)).not.toHaveProperty(
      'EnergyLimit',
    );
    const balanceOf = {
      owner_address: KEY_HEX,
      contract_address: USDT_HEX,
      data: `70a08231${KEY_HEX.slice(2).padStart(64, '0')}`,
    };
    expect(await post('/wallet/triggerconstantcontract', balanceOf)).toMatchObject({
      constant_result: [word(10n)],
    });
    expect(
      await post('/walletsolidity/triggerconstantcontract', balanceOf),
    ).toMatchObject({
      constant_result: [word(5n)],
    });
    for (const path of [
      '/walletsolidity/broadcasthex',
      '/walletsolidity/gettransactionfrompending',
    ]) {
      const answer = await node.fetch.fetch(`${url}${path}`, {
        method: 'POST',
        body: '{}',
      });
      expect(answer.status).toBe(404);
    }
  });

  it('keeps refused pool entries from spending bandwidth at admission (the #admit half of the fix)', async () => {
    const { node, send, trx } = setup();
    node.fund(KEY_ADDRESS, TRX);
    node.fund(RECIPIENT, 1n);
    const genesis = node.block(0) as { id: string; timestamp: number };
    const onGenesis = {
      refBlockBytes: genesis.id.slice(12, 16),
      refBlockHash: genesis.id.slice(16, 32),
    };
    node.mine();
    node.fund(KEY_ADDRESS, 10n * TRX);
    for (const amount of [5n * TRX, 5n * TRX + 1n]) {
      expect(await send(trx(amount, onGenesis))).toMatchObject({ result: true });
    }
    node.reorg(1);
    // Both pooled transfers are now refused. Had each counted its free bandwidth, the third
    // transfer would burn 0.268 TRX for bandwidth and could no longer pay 0.9 TRX.
    const third = (await send(trx(900_000n))) as { txid: string; result: boolean };
    expect(third.result).toBe(true);
    node.mine();
    expect(node.transaction(third.txid)?.blockNumber).toBe(2);
    expect(node.balance(KEY_ADDRESS)).toBe(100_000n);
  });

  it("pins the size caps: signed size + 128 at 512,000, and a new account's 1,000 bytes", async () => {
    const { node, send, trx } = setup();
    node.fund(KEY_ADDRESS, 2_000n * TRX);
    node.fund(RECIPIENT, 1n);
    const fits = memoFor(
      512_000,
      (memo) => trx(1n, { data: memo }),
      (bytes) => bytes + 128,
    );
    expect(await send(fits)).toMatchObject({ result: true });
    const over = memoFor(
      512_001,
      (memo) => trx(2n, { data: memo }),
      (bytes) => bytes + 128,
    );
    const overId = signedTransaction(over).id;
    expect(await send(over)).toMatchObject({
      code: 'TOO_BIG_TRANSACTION_ERROR',
      message: `Too big transaction with result, TxId ${overId}, the size is 512001 bytes, maxTxSize 512000`,
    });
    // BandwidthProcessor: a transfer that creates an account, without its signatures.
    const fresh = (amount: bigint) => (memo: string) =>
      trx(amount, {
        data: memo,
        contract: { type: 'TransferContract', owner: KEY_HEX, to: OTHER_HEX, amount },
      });
    const tooBig = memoFor(1_001, fresh(TRX), (bytes) => bytes - 65);
    expect(await send(tooBig)).toMatchObject({
      code: 'TOO_BIG_TRANSACTION_ERROR',
      message: `Too big new account transaction, TxId ${signedTransaction(tooBig).id}, the size is 1001 bytes, maxTxSize 1000`,
    });
    expect(
      await send(memoFor(1_000, fresh(TRX + 1n), (bytes) => bytes - 65)),
    ).toMatchObject({
      result: true,
    });
  });

  it('pins the bandwidth of a transfer that creates an account: staked or the fee, never free', async () => {
    const { node, send, trx, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const paid = (await send(trx(TRX))) as { txid: string };
    node.mine();
    expect(
      await post('/wallet/gettransactioninfobyid', { value: paid.txid }),
    ).toMatchObject({
      receipt: { net_fee: 100_000 },
    });
    const resources = await post('/wallet/getaccountresource', { address: KEY_HEX });
    expect(resources).not.toHaveProperty('freeNetUsed');
    node.stake(KEY_ADDRESS, { bandwidth: 1_000n });
    const staked = (await send(
      trx(TRX, {
        contract: {
          type: 'TransferContract',
          owner: KEY_HEX,
          to: OTHER_HEX,
          amount: TRX,
        },
      }),
    )) as { txid: string };
    node.mine();
    const info = await post('/wallet/gettransactioninfobyid', { value: staked.txid });
    expect(info).toMatchObject({
      fee: 1_000_000,
      receipt: { net_usage: expect.any(Number) },
    });
    expect(info.receipt).not.toHaveProperty('net_fee');
    expect(
      await post('/wallet/getaccountresource', { address: KEY_HEX }),
    ).not.toHaveProperty('freeNetUsed');
  });

  it("serves a TRC-20 call's return word and an exact int64 timestamp", async () => {
    const { node, url, call, post, sendWire } = setup();
    node.fund(KEY_ADDRESS, 100n * TRX);
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    const stamp = 2n ** 60n + 1n;
    const { txid } = (await sendWire(call(100_000_000), { timestamp: stamp })) as {
      txid: string;
    };
    node.mine();
    expect(await post('/wallet/gettransactioninfobyid', { value: txid })).toMatchObject({
      contractResult: [word(1n)],
    });
    const text = await (
      await node.fetch.fetch(`${url}/wallet/gettransactionbyid`, {
        method: 'POST',
        body: JSON.stringify({ value: txid }),
      })
    ).text();
    expect(text).toContain(`"timestamp":${stamp}`);
  });

  it('floors lied JSON-RPC timestamps to whole seconds, and lets an interception wait for its signal', async () => {
    const { node, url } = setup();
    node.mine();
    node.lieAboutTimestamps('main', 1_500);
    const answer = (await (
      await node.fetch.fetch(`${url}/jsonrpc`, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          method: 'eth_getBlockByNumber',
          params: ['0x1', false],
        }),
      })
    ).json()) as { result: { timestamp: string } };
    const at = (node.block(1) as { timestamp: number }).timestamp;
    expect(answer.result.timestamp).toBe(
      `0x${Math.floor((at - 1_500) / 1000).toString(16)}`,
    );
    node.intercept('main', '/wallet/getaccount', (_request, signal) => hang(signal));
    const aborted = new AbortController();
    const pending = node.fetch.fetch(`${url}/wallet/getaccount`, {
      method: 'POST',
      body: '{}',
      signal: aborted.signal,
    });
    aborted.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
    node.intercept('main', '/wallet/getnowblock', async () => ({ json: { late: 1 } }));
    const late = await node.fetch.fetch(`${url}/wallet/getnowblock`, {
      method: 'POST',
      body: '{}',
    });
    expect(await late.json()).toEqual({ late: 1 });
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

  it('accepts ret, ref_block_num and the default active permission as java-tron does, and echoes ret', async () => {
    const { node, trx, broadcast, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.fund(RECIPIENT, 1n);
    // `ret` is parsed, echoed, then cleared: the same txID, and bandwidth without it.
    const rawHex = encodeRawData(trx(1n));
    const id = idOf(rawHex);
    const sig = signTxId(id);
    const withRet = await broadcast(
      encodeWireTransaction(rawHex, [sig], [{ contractRet: 1 }, { fee: 5n, ret: 1 }]),
    );
    expect(withRet).toMatchObject({ result: true, txid: id });
    expect(JSON.parse(withRet.transaction as string)).toMatchObject({
      signature: [sig],
      ret: [{ contractRet: 'SUCCESS' }, { fee: 5, ret: 'FAILED' }],
    });
    // `ref_block_num` is signed over and served.
    const numbered = signRawHex(encodeWireRaw(trx(2n), { refBlockNum: 7n }));
    expect(await broadcast(numbered.hex)).toMatchObject({
      result: true,
      txid: numbered.id,
    });
    // Permission 2 (the default active permission) holds the owner's key; 1 and 3 do not exist.
    const active = signRawHex(encodeWireRaw(trx(3n), { permissionId: 2 }));
    expect(await broadcast(active.hex)).toMatchObject({ result: true });
    for (const permissionId of [1, 3]) {
      expect(
        await broadcast(signRawHex(encodeWireRaw(trx(4n), { permissionId })).hex),
      ).toMatchObject({
        code: 'SIGERROR',
        message: "Validate signature error: permission isn't exit",
      });
    }
    node.mine();
    expect(node.transaction(id)?.size).toBe(
      BigInt(encodeTransaction(rawHex, [sig]).length / 2),
    );
    expect(
      await post('/wallet/gettransactionbyid', { value: numbered.id }),
    ).toMatchObject({
      raw_data: { ref_block_num: 7 },
    });
    expect(await post('/wallet/gettransactionbyid', { value: active.id })).toMatchObject({
      raw_data: { contract: [{ Permission_id: 2 }] },
    });
  });

  it('refuses two contracts, and checks the next slot before the signature (texts Task 5 matches)', async () => {
    const { node, trx, ref, broadcast } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.fund(RECIPIENT, 1n);
    const two = signRawHex(encodeWireRaw(trx(1n), { moreContracts: [trx(2n).contract] }));
    expect(await broadcast(two.hex)).toMatchObject({
      code: 'CONTRACT_VALIDATE_ERROR',
      message: `Contract validate error : tx ${two.id} contract size should be exactly 1, this is extend feature ,actual :2`,
    });
    // Wallet.broadcastTransaction checks the next slot before pushTransaction checks the
    // signature: a late transaction signed by the wrong key is refused as expired.
    const late = signedTransaction(
      trx(1n, { expiration: ref().timestamp + 2_999 }),
      OTHER_KEY,
    );
    expect(await broadcast(late.hex)).toMatchObject({
      code: 'TRANSACTION_EXPIRATION_ERROR',
      message: 'Transaction expired',
    });
  });

  it('hashes the re-serialized raw data: a non-canonical encoding signed as sent fails SIGERROR', async () => {
    const { node, trx, broadcast, post } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.fund(RECIPIENT, 1n);
    const raw = trx(1n);
    const canonical = encodeRawData(raw);
    const expiration = `40${varintHex(BigInt(raw.expiration))}`;
    const timestamp = `70${varintHex(BigInt(raw.timestamp))}`;
    expect(canonical.endsWith(timestamp)).toBe(true);
    const last = parseInt(expiration.slice(-2), 16) | 0x80;
    const variants = [
      // fee_limit = 0 written out
      `${canonical}900100`,
      // timestamp (field 14) first
      `${timestamp}${canonical.slice(0, -timestamp.length)}`,
      // the expiration's varint one byte too long
      canonical.replace(expiration, `${expiration.slice(0, -2)}${last.toString(16)}00`),
    ];
    const signedBySomeoneElse = new RegExp(
      `^Validate signature error: ${idOf(canonical)} is signed by T\\w+ but it is not contained of permission\\.$`,
    );
    for (const variant of variants) {
      expect(variant).not.toBe(canonical);
      expect(await broadcast(signRawHex(variant).hex)).toMatchObject({
        code: 'SIGERROR',
        message: expect.stringMatching(signedBySomeoneElse),
      });
    }
    // Signed over the re-serialized bytes, the same encoding is admitted under their txID,
    // and the node serves them, not the input.
    const answer = await broadcast(
      encodeTransaction(variants[0] as string, [signTxId(idOf(canonical))]),
    );
    expect(answer).toMatchObject({ result: true, txid: idOf(canonical) });
    node.mine();
    expect(
      await post('/wallet/gettransactionbyid', { value: idOf(canonical) }),
    ).toMatchObject({ raw_data_hex: canonical });
  });

  it("reads call_token_value and token_id: java-tron's TRC-10 refusals, and a placed movement served", async () => {
    const { node, call, sendWire, post } = setup();
    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    node.fund(KEY_ADDRESS, 10n * TRX);
    const cases: [WireExtras, string][] = [
      [{ callTokenValue: -1n, tokenId: 1_000_001n }, 'tokenValue must be >= 0'],
      [{ callTokenValue: 5n, tokenId: 5n }, 'tokenId must be > 1000000'],
      [{ callTokenValue: 5n }, 'invalid arguments with tokenValue = 5, tokenId = 0'],
      [{ callTokenValue: 5n, tokenId: 1_000_001n }, 'No asset !'],
    ];
    for (const [extras, message] of cases) {
      expect(await sendWire(call(10_000_000), extras)).toMatchObject({
        code: 'CONTRACT_VALIDATE_ERROR',
        message: `Contract validate error : ${message}`,
      });
    }
    const moved = signRawHex(
      encodeWireRaw(call(10_000_000), { callTokenValue: 5n, tokenId: 1_000_001n }),
    );
    expect(node.place(moved.hex)).toBe(moved.id);
    node.mine();
    expect(await post('/wallet/gettransactionbyid', { value: moved.id })).toMatchObject({
      raw_data: {
        contract: [
          { parameter: { value: { call_token_value: 5, token_id: 1_000_001 } } },
        ],
      },
    });
  });

  it('places only what a block could hold, and moves the TRX of a placed transfer', async () => {
    const { node, trx, ref, get } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const transfer = (amount: bigint, extra: Partial<TronRawData> = {}, to = OTHER_HEX) =>
      trx(amount, {
        contract: { type: 'TransferContract', owner: KEY_HEX, to, amount },
        ...extra,
      });
    const withSignatures = (raw: TronRawData, count: number) => {
      const rawHex = encodeRawData(raw);
      return encodeTransaction(rawHex, Array<string>(count).fill(signTxId(idOf(rawHex))));
    };
    const moved = node.place(signedTransaction(transfer(TRX)).hex);
    const dropped = [
      node.place(signedTransaction(transfer(0n)).hex),
      node.place(signedTransaction(transfer(1n, {}, '41' + '55'.repeat(19))).hex),
      node.place(signedTransaction(transfer(2n, {}, KEY_HEX)).hex),
      node.place(withSignatures(transfer(3n), 0)),
      node.place(withSignatures(transfer(4n), 6)),
      node.place(
        signRawHex(
          encodeWireRaw(transfer(5n), { moreContracts: [transfer(6n).contract] }),
        ).hex,
      ),
      node.place(signedTransaction(transfer(7n, { expiration: ref().timestamp })).hex),
      node.place(signedTransaction(transfer(8n, { refBlockHash: '00'.repeat(8) })).hex),
      node.place(signedTransaction(transfer(100n * TRX)).hex),
    ];
    node.mine();
    expect(node.transaction(moved)?.blockNumber).toBe(1);
    for (const id of dropped) expect(node.transaction(id)).toBeUndefined();
    expect(node.balance(OTHER)).toBe(TRX);
    expect(node.balance(KEY_ADDRESS)).toBe(9n * TRX);
    const history = await get(`/v1/accounts/${OTHER}/transactions`);
    expect(history.data.map((t) => t.txID)).toEqual([moved]);
  });

  it('drops a placed transaction whose reference block a reorg orphaned', async () => {
    const { node, trx } = setup();
    node.fund(KEY_ADDRESS, 10n * TRX);
    node.mine();
    const id = node.place(signedTransaction(trx(TRX)).hex);
    node.mine();
    expect(node.transaction(id)?.blockNumber).toBe(2);
    expect(node.balance(RECIPIENT)).toBe(TRX);
    node.reorg(2);
    node.mine();
    expect(node.transaction(id)).toBeUndefined();
    expect(node.exists(RECIPIENT)).toBe(false);
  });

  it("encodes the wire extras canonically: without them, the bytes are the test codec's", () => {
    for (const vector of VECTORS) {
      expect(encodeWireRaw(vector.raw)).toBe(vector.rawHex);
    }
  });
});
