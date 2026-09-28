import { sha256 } from '@noble/hashes/sha256';
import { TRANSFER_TOPIC, encodeTransfer } from '../../../src/adapters/tron/abi';
import { tronwebCodec } from '../../../src/adapters/tron/codec';
import {
  chainVerdict,
  decodeTransaction,
  transferLanded,
  verdictOf,
} from '../../../src/adapters/tron/decode';
import type { TronLog, TronTxInfo, TronTxJson } from '../../../src/adapters/tron/http';
import type { TronRawData } from '../../../src/adapters/tron/types';
import { toBase58Address, toHexAddress } from '../../../src/adapters/tron/address';
import { createTronExt, createTronReader } from '../../../src/adapters/tron/reader';
import { fromHex, toHex, utf8ToBytes } from '../../../src/core/util/bytes';
import type { FakeReply } from '../../../src/testing/fake-fetch';
import { submit, tronHarness } from './support/context';
import { encodeWireRaw, type WireExtras } from './support/node';
import { signRawHex } from './support/signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
} from './support/vectors';

const TOKEN = { standard: 'trc20', contract: USDT } as const;
const ref = (id: string) => ({ id, idKind: 'tx-hash' as const, canonical: true });

function setup(options: Parameters<typeof tronHarness>[0] = {}) {
  const h = tronHarness({ ...options, node: { solidDepth: 2, ...options.node } });
  h.node.fund(KEY_ADDRESS, 100_000_000n);
  h.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
  h.node.mintToken(USDT, KEY_ADDRESS, 1_000n);
  return { ...h, reader: createTronReader(h.ctx) };
}

describe('Tron reader', () => {
  it('reads TRX and TRC-20 balances, heights and blocks', async () => {
    const h = setup();
    expect(await h.run(h.reader.getBalance(KEY_ADDRESS, 'native'))).toBe(100_000_000n);
    expect(await h.run(h.reader.getBalance(RECIPIENT, 'native'))).toBe(0n);
    expect(await h.run(h.reader.getBalance(KEY_ADDRESS, TOKEN))).toBe(1_000n);
    for (let i = 0; i < 4; i++) h.node.mine();
    expect(await h.run(h.reader.getBlockHeight())).toBe(4n);
    expect(await h.run(h.reader.getFinalizedHeight())).toBe(2n);
    const block = await h.run(h.reader.getBlock(3n));
    expect(block).toEqual({
      height: 3n,
      hash: h.node.block(3)?.id,
      parentHash: h.node.block(2)?.id,
      timestamp: h.node.block(3)?.timestamp,
    });
    expect(await h.run(h.reader.getBlock(h.node.block(3)?.id ?? ''))).toEqual(block);
    expect(await h.run(h.reader.getBlock(99n))).toBeNull();
    expect(await h.run(h.reader.getBlock('nope'))).toBeNull();
  });

  it('decodes a TRX transfer with its memo, and a TRC-20 transfer from its Transfer log', async () => {
    const h = setup();
    const trx = await submit(h, 'trx', { data: '696e766f696365' });
    expect(await h.run(h.reader.getTransaction(trx))).toMatchObject({
      observation: { seen: 'mempool' },
      decoding: 'partial',
    });
    h.node.mine();
    const token = await submit(h, 'trc20');
    h.node.mine();
    expect(await h.run(h.reader.getTransaction(trx))).toMatchObject({
      observation: { seen: 'block', blockHeight: 1n, success: true },
      transfers: [
        {
          locator: 'native',
          from: [KEY_ADDRESS],
          to: RECIPIENT,
          asset: 'native',
          amount: 1_000n,
          memo: 'invoice',
        },
      ],
      decoding: 'complete',
      details: { contract: 'TransferContract', result: 'SUCCESS' },
    });
    expect(await h.run(h.reader.getTransaction(token))).toMatchObject({
      observation: { seen: 'block', blockHeight: 2n, success: true },
      transfers: [
        {
          locator: 'log:0',
          from: [KEY_ADDRESS],
          to: RECIPIENT,
          asset: TOKEN,
          amount: 25n,
          source: 'token-event',
        },
      ],
      decoding: 'partial',
    });
    expect(await h.run(h.reader.getTransaction('00'.repeat(32)))).toBeNull();
    expect(await h.run(h.reader.getTransaction('bad'))).toBeNull();
  });

  it('observes none, mempool and block; guards our own Attempts only (lessons 7 and 15)', async () => {
    const h = setup();
    h.node.deployToken(RECIPIENT, { symbol: 'FAKE', decimals: 6, mode: 'no-log' });
    h.node.mintToken(RECIPIENT, KEY_ADDRESS, 100n);
    expect(
      await h.run(h.reader.observe(ref('00'.repeat(32)), undefined, undefined)),
    ).toEqual({ seen: 'none' });
    const id = await submit(h, 'trc20');
    expect(await h.run(h.reader.observe(ref(id), undefined, undefined))).toEqual({
      seen: 'mempool',
    });
    h.node.mine();
    expect(await h.run(h.reader.observe(ref(id), undefined, undefined))).toMatchObject({
      seen: 'block',
      blockHeight: 1n,
      blockHash: h.node.block(1)?.id,
      success: true,
    });
    const phantom = await submit(h, 'trc20', {
      contract: {
        type: 'TriggerSmartContract',
        owner: toHexAddress(KEY_ADDRESS),
        contract: toHexAddress(RECIPIENT),
        data: encodeTransfer(RECIPIENT, 5n),
      },
    });
    h.node.mine();
    // Our own Attempt (an ordering is present): no Transfer log, so nothing moved.
    const ours = { kind: 'expiry' as const, expiresAtMs: Number.MAX_SAFE_INTEGER };
    expect(await h.run(h.reader.observe(ref(phantom), ours, KEY_ADDRESS))).toMatchObject({
      seen: 'block',
      success: false,
      reason: 'token transfer not evidenced',
    });
    // A status lookup by id (no ordering) reports the chain's own view.
    expect(
      await h.run(h.reader.observe(ref(phantom), undefined, undefined)),
    ).toMatchObject({ seen: 'block', success: true });
    // General decoding reports the chain's own success (lesson 15).
    expect(await h.run(h.reader.getTransaction(phantom))).toMatchObject({
      observation: { success: true },
      transfers: [],
    });
  });

  it('classifies token metadata failures (lesson 13)', async () => {
    const h = setup();
    h.node.deployToken(RECIPIENT, {
      symbol: 'BAD',
      decimals: 6,
      mode: 'reverting-metadata',
    });
    expect(await h.run(h.reader.getTokenMetadata?.(TOKEN) as Promise<unknown>)).toEqual({
      symbol: 'USDT',
      decimals: 6,
    });
    for (const contract of [RECIPIENT, KEY_ADDRESS]) {
      await expect(
        h.run(
          h.reader.getTokenMetadata?.({
            standard: 'trc20',
            contract,
          }) as Promise<unknown>,
        ),
      ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION', retryable: false });
    }
    h.node.intercept('main', '/wallet/triggerconstantcontract', () => ({
      status: 401,
      text: 'no',
    }));
    await expect(
      h.run(h.reader.getTokenMetadata?.(TOKEN) as Promise<unknown>),
    ).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
      retryable: false,
    });
  });

  it('normalizes token refs to base58 and serves ext.tron.getResources', async () => {
    const h = setup();
    expect(
      h.reader.normalizeTokenRef?.({ standard: 'trc20', contract: toHexAddress(USDT) }),
    ).toEqual(TOKEN);
    expect(() =>
      h.reader.normalizeTokenRef?.({ standard: 'erc20', contract: USDT }),
    ).toThrow(expect.objectContaining({ code: 'ASSET_RESOLUTION' }));
    h.node.stake(KEY_ADDRESS, { bandwidth: 5_000n, energy: 9n });
    expect(await h.run(createTronExt(h.ctx).tron.getResources(KEY_ADDRESS))).toEqual({
      activated: true,
      freeBandwidth: 600n,
      stakedBandwidth: 5_000n,
      energy: 9n,
    });
    expect(await h.run(createTronExt(h.ctx).tron.getResources(RECIPIENT))).toMatchObject({
      activated: false,
    });
  });

  it('tags reads read and heights and observe monitor (R41)', async () => {
    const h = setup();
    await h.run(h.reader.getBalance(KEY_ADDRESS, 'native'));
    await h.run(h.reader.getFinalizedHeight());
    await h.run(h.reader.observe(ref('00'.repeat(32)), undefined, undefined));
    expect(h.calls.map((c) => [c.path, c.tags.purpose])).toEqual([
      ['/wallet/getaccount', 'read'],
      ['/walletsolidity/getblock', 'monitor'],
      ['/wallet/gettransactioninfobyid', 'monitor'],
      ['/wallet/gettransactionfrompending', 'monitor'],
    ]);
  });

  it('reads and decodes amounts above 2^53 sun exactly (A12)', async () => {
    const h = setup();
    const huge = 2n ** 60n;
    h.node.fund(RECIPIENT, huge);
    expect(await h.run(h.reader.getBalance(RECIPIENT, 'native'))).toBe(huge);
    h.node.fund(KEY_ADDRESS, 2n * huge);
    // A third party's transfer of 2^60 sun (built with the independent codec).
    const id = await submit(h, 'trx', {
      contract: {
        type: 'TransferContract',
        owner: toHexAddress(KEY_ADDRESS),
        to: toHexAddress(RECIPIENT),
        amount: huge,
      },
    });
    h.node.mine();
    expect(await h.run(h.reader.getTransaction(id))).toMatchObject({
      decoding: 'complete',
      transfers: [{ locator: 'native', to: RECIPIENT, amount: huge }],
    });
  });

  it('counts a token transfer from the sender to the recipient of any positive amount (lessons 7 and 15)', () => {
    const raw: TronRawData = {
      refBlockBytes: '0000',
      refBlockHash: '00'.repeat(8),
      expiration: 1,
      timestamp: 1,
      contract: {
        type: 'TriggerSmartContract',
        owner: toHexAddress(KEY_ADDRESS),
        contract: toHexAddress(USDT),
        data: encodeTransfer(RECIPIENT, 5n),
      },
    };
    const word = (hex: string) => hex.slice(2).padStart(64, '0');
    const info = (to: string, amount: bigint, emitter = USDT): TronTxInfo => ({
      id: '00'.repeat(32),
      blockNumber: 1n,
      blockTimestamp: 1,
      fee: 0n,
      receiptResult: 'SUCCESS',
      failed: false,
      logs: [
        {
          address: toHexAddress(emitter).slice(2),
          topics: [
            TRANSFER_TOPIC,
            word(toHexAddress(KEY_ADDRESS)),
            word(toHexAddress(to)),
          ],
          data: amount.toString(16).padStart(64, '0'),
        },
      ],
    });
    expect(transferLanded(raw, info(RECIPIENT, 5n))).toBe(true);
    expect(transferLanded(raw, info(RECIPIENT, 4n))).toBe(true); // a fee-on-transfer token
    expect(transferLanded(raw, info(RECIPIENT, 0n))).toBe(false); // nothing moved
    expect(transferLanded(raw, info(KEY_ADDRESS, 5n))).toBe(false); // another recipient
    expect(transferLanded(raw, info(RECIPIENT, 5n, RECIPIENT))).toBe(false); // another contract
  });
});

// ---- beyond the brief: the Task 2–5 carries (phantom success, call values, strict verdict
// fields, lenient readers, token metadata under the proof quorum) -------------------------

const BLOCK = 'ab'.repeat(32);
const undecided = expect.objectContaining({
  code: 'PROVIDER_UNAVAILABLE',
  retryable: true,
});
const OURS = { kind: 'expiry' as const, expiresAtMs: Number.MAX_SAFE_INTEGER };

/** A plain TRC-20 `transfer(RECIPIENT, 5)` on USDT, and a 1-sun TRX transfer, as raw data. */
const CALL: TronRawData = {
  refBlockBytes: '0000',
  refBlockHash: '00'.repeat(8),
  expiration: 1,
  timestamp: 1,
  contract: {
    type: 'TriggerSmartContract',
    owner: KEY_HEX,
    contract: USDT_HEX,
    data: encodeTransfer(RECIPIENT, 5n),
  },
};
const PAYMENT: TronRawData = {
  ...CALL,
  contract: { type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount: 1n },
};

/** A node's transaction answer for `raw` (canonical bytes, with java-tron's extra fields). */
function txOf(
  raw: TronRawData,
  extras: WireExtras = {},
  contractRet?: string,
): TronTxJson {
  const rawHex = encodeWireRaw(raw, extras);
  return {
    id: toHex(sha256(fromHex(rawHex))),
    rawHex,
    ...(contractRet !== undefined ? { contractRet } : {}),
  };
}

function infoOf(tx: TronTxJson, fields: Partial<TronTxInfo> = {}): TronTxInfo {
  return {
    id: tx.id,
    blockNumber: 1n,
    blockTimestamp: 1,
    fee: 0n,
    failed: false,
    logs: [],
    ...fields,
  };
}

const topicOf = (address: string) => toHexAddress(address).slice(2).padStart(64, '0');

function transferLog(from: string, to: string, amount: bigint, emitter = USDT): TronLog {
  return {
    address: toHexAddress(emitter).slice(2),
    topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
    data: amount.toString(16).padStart(64, '0'),
  };
}

/**
 * Mainnet block 2,000,000 (blockID `00000000001e8480a365…6613`), read from TronGrid
 * (`/wallet/getblockbynum`, `/wallet/gettransactioninfobyid`) on 2026-09-28. Both
 * transactions predate `ret`: the block serves none. Each `rawHex` hashes to its id.
 */
const EARLY_TRX = {
  id: 'b60b4cf023925550cdcea3f33bdbc98a52c9a6200010c216340ffc6a0f96c50d',
  rawHex:
    '0a02847f220804c6dc78b5042aba40a8f6ead8d92c5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a154195ff58da37934de4e36d10c823045d0e14817f14121541b686ab4d2b16e53c7aeb0b4beff8652ab01ab89018e98e0670cba5e7d8d92c',
};
/** A TRC-10 `TransferAssetContract` from the same block (its info: `fee` 2120). */
const EARLY_TRC10 = {
  id: '0e3f72936eb2975f33aa477da4d43a1d4cfb1356c493ba3284dd307818506372',
  rawHex:
    '0a02847e220818be14cf0fa885eb40f0deead8d92c5a700802126c0a32747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e736665724173736574436f6e747261637412360a0449504653121541d13433f53fdf88820c2e530da7828ce15d6585cb1a154199d668f36a676350804aa0b5cb5aa3d20a28fd782001708793e7d8d92c',
};
const EARLY_BLOCK = '00000000001e8480a365fc008c2d6331b24ca6fa58d839c9c144ea8786a65613';

describe('Tron reader: verdicts and lenient decoding', () => {
  it('accounts for TRX a contract call sends, and never takes such a call for a plain TRC-20 transfer', async () => {
    const h = setup();
    const head = h.node.block(h.node.head) as { id: string; timestamp: number };
    const at = (n: number): TronRawData => ({
      ...CALL,
      refBlockBytes: head.id.slice(12, 16),
      refBlockHash: head.id.slice(16, 32),
      expiration: head.timestamp + 60_000,
      timestamp: head.timestamp + n,
      feeLimit: 100_000_000,
    });
    const huge = 2n ** 60n + 1n;
    const place = (raw: TronRawData, extras: WireExtras, result?: 'REVERT') =>
      h.node.place(signRawHex(encodeWireRaw(raw, extras)).hex, result);
    const paying = place(at(1), { callValue: huge });
    const trc10 = place(at(2), { callTokenValue: 7n, tokenId: 1_000_001n });
    const reverted = place(at(3), { callValue: 3n }, 'REVERT');
    h.node.mine();
    // The TRX the call sent moved to the contract, read exactly from the signed bytes.
    expect(await h.run(h.reader.getTransaction(paying))).toMatchObject({
      observation: { seen: 'block', success: true },
      transfers: [
        {
          locator: 'native',
          from: [KEY_ADDRESS],
          to: USDT,
          asset: 'native',
          amount: huge,
          source: 'native',
        },
      ],
      decoding: 'partial',
      details: { contract: 'TriggerSmartContract', callValue: huge },
    });
    // A TRC-10 value has no asset here: kept in the details, and the decoding is partial.
    expect(await h.run(h.reader.getTransaction(trc10))).toMatchObject({
      observation: { success: true },
      transfers: [],
      decoding: 'partial',
      details: { callTokenValue: 7n, tokenId: 1_000_001n },
    });
    // A reverted call returned its value: nothing moved.
    expect(await h.run(h.reader.getTransaction(reverted))).toMatchObject({
      observation: { success: false, reason: 'reverted' },
      transfers: [],
      decoding: 'complete',
    });
    // The driver never builds a call with a value, so a verdict on one decides nothing; a
    // status lookup by id reports the chain's own view.
    await expect(
      h.run(h.reader.observe(ref(paying), OURS, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(
      await h.run(h.reader.observe(ref(paying), undefined, undefined)),
    ).toMatchObject({ seen: 'block', success: true });

    // With the token's own Transfer log as well: both movements, and still no landing.
    const tx = txOf(CALL, { callValue: 9n }, 'SUCCESS');
    const info = infoOf(tx, {
      receiptResult: 'SUCCESS',
      logs: [transferLog(KEY_ADDRESS, RECIPIENT, 5n)],
    });
    const raw = tronwebCodec.readRaw(tx.rawHex) as TronRawData;
    expect(raw.contract).toMatchObject({ callValue: 9n });
    expect(transferLanded(raw, info)).toBe(false);
    expect(() => verdictOf(tronwebCodec, tx, info)).toThrow(undecided);
    expect(decodeTransaction(tronwebCodec, tx, info, BLOCK)).toMatchObject({
      transfers: [
        { locator: 'native', to: USDT, asset: 'native', amount: 9n },
        { locator: 'log:0', to: RECIPIENT, asset: TOKEN, amount: 5n },
      ],
      decoding: 'partial',
    });
  });

  it('reads verdict fields strictly: a missing or contradicting one decides nothing (lesson 6)', () => {
    const tx = txOf(CALL, {}, 'SUCCESS');
    const logs = [transferLog(KEY_ADDRESS, RECIPIENT, 5n)];
    const good = infoOf(tx, { receiptResult: 'SUCCESS', logs });
    expect(verdictOf(tronwebCodec, tx, good)).toEqual({ success: true });
    const broken: [TronTxJson, TronTxInfo][] = [
      [tx, infoOf(tx, { logs })], // no receipt result
      [tx, { ...good, failed: true }], // FAILED under a SUCCESS receipt
      [{ ...tx, contractRet: 'REVERT' }, good], // ret contradicts the receipt
      [tx, { ...good, id: '00'.repeat(32) }], // another transaction's receipt
    ];
    for (const [t, i] of broken) {
      expect(() => verdictOf(tronwebCodec, t, i)).toThrow(undecided);
      expect(() => chainVerdict(tronwebCodec, t, i)).toThrow(undecided);
      expect(() => decodeTransaction(tronwebCodec, t, i, BLOCK)).toThrow(undecided);
    }
    // Our own Attempt's answer carries `contractRet`; the chain's view reads the receipt.
    const bare = { id: tx.id, rawHex: tx.rawHex };
    expect(() => verdictOf(tronwebCodec, bare, good)).toThrow(undecided);
    expect(chainVerdict(tronwebCodec, bare, good)).toEqual({ success: true });
    // Failures come from the receipt, as fixed texts.
    for (const [result, reason] of [
      ['OUT_OF_ENERGY', 'out of energy'],
      ['REVERT', 'reverted'],
      ['TRANSFER_FAILED', 'contract execution failed'],
    ] as const) {
      const failed = infoOf(tx, { receiptResult: result, failed: true });
      const t = { ...tx, contractRet: result };
      expect(verdictOf(tronwebCodec, t, failed)).toEqual({ success: false, reason });
      expect(chainVerdict(tronwebCodec, t, failed)).toEqual({ success: false, reason });
      expect(decodeTransaction(tronwebCodec, t, failed, BLOCK)).toMatchObject({
        observation: { seen: 'block', success: false, reason },
        transfers: [],
        decoding: 'complete',
      });
    }
    // The token's own Transfer event that does not read as one (its value indexed, say):
    // our own Attempt decides nothing; decoding skips it. Another contract's is foreign.
    const odd: TronLog = {
      ...logs[0]!,
      topics: [...logs[0]!.topics, '00'.repeat(32)],
      data: '',
    };
    const oddInfo = infoOf(tx, { receiptResult: 'SUCCESS', logs: [odd] });
    expect(() => verdictOf(tronwebCodec, tx, oddInfo)).toThrow(undecided);
    expect(chainVerdict(tronwebCodec, tx, oddInfo)).toEqual({ success: true });
    expect(decodeTransaction(tronwebCodec, tx, oddInfo, BLOCK)).toMatchObject({
      transfers: [],
      decoding: 'partial',
    });
    const foreign = { ...odd, address: RECIPIENT_HEX.slice(2) };
    expect(
      verdictOf(
        tronwebCodec,
        tx,
        infoOf(tx, { receiptResult: 'SUCCESS', logs: [foreign] }),
      ),
    ).toEqual({ success: false, reason: 'token transfer not evidenced' });
    // A TRX transfer: our own needs contractRet SUCCESS; FAILED is the chain's failure.
    const payment = txOf(PAYMENT, {}, 'SUCCESS');
    expect(verdictOf(tronwebCodec, payment, infoOf(payment))).toEqual({ success: true });
    expect(verdictOf(tronwebCodec, payment, infoOf(payment, { failed: true }))).toEqual({
      success: false,
      reason: 'execution failed',
    });
    // Someone else's transfer to the recipient is not ours.
    expect(
      verdictOf(
        tronwebCodec,
        tx,
        infoOf(tx, {
          receiptResult: 'SUCCESS',
          logs: [transferLog(USDT, RECIPIENT, 5n)],
        }),
      ),
    ).toEqual({ success: false, reason: 'token transfer not evidenced' });
    // A contract this model does not read is judged by its VM receipt when it has one; it is
    // never one of our own Attempts, so the guard decides nothing on it.
    const unread = { id: EARLY_TRC10.id, rawHex: EARLY_TRC10.rawHex };
    expect(() =>
      verdictOf(tronwebCodec, { ...unread, contractRet: 'SUCCESS' }, infoOf(unread)),
    ).toThrow(undecided);
    expect(
      chainVerdict(
        tronwebCodec,
        unread,
        infoOf(unread, { receiptResult: 'OUT_OF_ENERGY' }),
      ),
    ).toEqual({ success: false, reason: 'out of energy' });
    // A receipt comes with its block.
    expect(() => decodeTransaction(tronwebCodec, tx, good, undefined)).toThrow(undecided);
  });

  it('reads 2018 history, contract types it does not model and odd memos leniently', () => {
    for (const vector of [EARLY_TRX, EARLY_TRC10]) {
      expect(toHex(sha256(fromHex(vector.rawHex)))).toBe(vector.id);
    }
    const early = (id: string, fee = 0n): TronTxInfo => ({
      id,
      blockNumber: 2_000_000n,
      blockTimestamp: 1_535_905_488_000,
      fee,
      failed: false,
      logs: [],
    });
    // A TRX transfer from before `ret` existed: inclusion is its success (java-tron never
    // includes a failed TransferContract). Our own Attempts always carry `contractRet`.
    expect(
      decodeTransaction(tronwebCodec, EARLY_TRX, early(EARLY_TRX.id), EARLY_BLOCK),
    ).toMatchObject({
      observation: { seen: 'block', blockHeight: 2_000_000n, success: true },
      transfers: [
        {
          locator: 'native',
          from: [toBase58Address('4195ff58da37934de4e36d10c823045d0e14817f14')],
          to: toBase58Address('41b686ab4d2b16e53c7aeb0b4beff8652ab01ab890'),
          asset: 'native',
          amount: 100_201n,
        },
      ],
      decoding: 'complete',
      timestamp: 1_535_905_488_000,
    });
    expect(() => verdictOf(tronwebCodec, EARLY_TRX, early(EARLY_TRX.id))).toThrow(
      undecided,
    );
    // A contract type this model does not carry (TRC-10): readable, not decoded.
    expect(
      decodeTransaction(
        tronwebCodec,
        EARLY_TRC10,
        early(EARLY_TRC10.id, 2_120n),
        EARLY_BLOCK,
      ),
    ).toMatchObject({
      observation: { seen: 'block', success: true },
      fee: [{ asset: 'native', amount: 2_120n }],
      transfers: [],
      decoding: 'none',
      details: { contract: 'unknown' },
    });
    // Memos: bytes that are not UTF-8 are dropped (partial), never replaced; a BOM is kept;
    // a memo far above what the driver writes (256 bytes) reads in full.
    const memo = (data: string) => {
      const tx = txOf({ ...PAYMENT, data }, {}, 'SUCCESS');
      return decodeTransaction(tronwebCodec, tx, infoOf(tx), BLOCK);
    };
    const invalid = memo('ff');
    expect(invalid.decoding).toBe('partial');
    expect(invalid.transfers[0]).not.toHaveProperty('memo');
    expect(memo(toHex(utf8ToBytes('﻿A')))).toMatchObject({
      decoding: 'complete',
      transfers: [{ memo: '﻿A' }],
    });
    const large = 'x'.repeat(400_000);
    expect(memo(toHex(utf8ToBytes(large))).transfers[0]?.memo).toBe(large);
  });

  it('never answers "not seen" for a transaction the node holds but cannot serve whole yet', async () => {
    const h = setup();
    const id = await submit(h, 'trx');
    h.node.mine();
    let hidden = '';
    for (const path of [
      '/wallet/gettransactioninfobyid',
      '/wallet/getblock',
      '/wallet/gettransactionbyid',
    ]) {
      h.node.intercept('main', path, () => (hidden === path ? { json: {} } : undefined));
    }
    const unavailable = { code: 'PROVIDER_UNAVAILABLE', retryable: true };
    // The transaction is served, its receipt not yet.
    hidden = '/wallet/gettransactioninfobyid';
    await expect(h.run(h.reader.getTransaction(id))).rejects.toMatchObject(unavailable);
    // The receipt names a block the node cannot serve yet.
    hidden = '/wallet/getblock';
    await expect(h.run(h.reader.getTransaction(id))).rejects.toMatchObject(unavailable);
    await expect(
      h.run(h.reader.observe(ref(id), undefined, undefined)),
    ).rejects.toMatchObject(unavailable);
    // The receipt is indexed, the transaction not yet.
    hidden = '/wallet/gettransactionbyid';
    await expect(
      h.run(h.reader.observe(ref(id), OURS, KEY_ADDRESS)),
    ).rejects.toMatchObject(unavailable);
    hidden = '';
    expect(await h.run(h.reader.observe(ref(id), OURS, KEY_ADDRESS))).toMatchObject({
      seen: 'block',
      blockHeight: 1n,
      success: true,
    });
  });

  it('reads token metadata under the proof quorum, confirms "no contract" structurally, and caches no lagging or missing answer', async () => {
    const h = setup({ endpoints: ['a', 'b'] });
    let answer: FakeReply | undefined;
    for (const endpoint of ['a', 'b']) {
      h.node.intercept(endpoint, '/wallet/triggerconstantcontract', () => answer);
    }
    const metadata = (contract: string) =>
      h.run(
        h.reader.getTokenMetadata?.({ standard: 'trc20', contract }) as Promise<unknown>,
      );
    const tags = {
      purpose: 'read',
      retry: 'safe',
      quorum: 'proof',
      exactIntegers: true,
      quorumKey: true,
    };
    expect(await metadata(USDT)).toEqual({ symbol: 'USDT', decimals: 6 });
    expect(h.calls.splice(0).map((c) => [c.path, c.tags])).toEqual([
      ['/wallet/triggerconstantcontract', tags],
      ['/wallet/triggerconstantcontract', tags],
    ]);
    // "No contract" is the token's permanent problem only once getcontract confirms it.
    await expect(metadata(KEY_ADDRESS)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
    });
    expect(h.calls.splice(0).map((c) => [c.path, c.tags])).toEqual([
      ['/wallet/triggerconstantcontract', tags],
      ['/wallet/getcontract', tags],
    ]);
    // A token deployed at the head, which endpoint b does not serve yet: not yet, not "none".
    h.node.mine();
    h.node.deployToken(RECIPIENT, { symbol: 'NEW', decimals: 18 });
    h.node.lag('b', 1);
    await expect(metadata(RECIPIENT)).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.lag('b', 0);
    expect(await metadata(RECIPIENT)).toEqual({ symbol: 'NEW', decimals: 18 });
    // An answer without its result is malformed, never a default.
    answer = {
      json: { result: { result: true }, energy_used: 300, transaction: { ret: [{}] } },
    };
    await expect(metadata(USDT)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // "No contract" for an address getcontract shows a contract at: decide nothing.
    answer = {
      json: {
        result: {
          code: 'CONTRACT_VALIDATE_ERROR',
          message: toHex(utf8ToBytes('Smart contract is not exist.')),
        },
      },
    };
    await expect(metadata(USDT)).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('reads nothing for an id or height outside the chain (lesson 20)', async () => {
    const h = setup();
    expect(await h.run(h.reader.getBlock(-1n))).toBeNull();
    expect(await h.run(h.reader.getBlock(2n ** 63n))).toBeNull();
    expect(await h.run(h.reader.getBlock('ab'.repeat(50_000)))).toBeNull();
    expect(await h.run(h.reader.getTransaction('ab'.repeat(50_000)))).toBeNull();
    expect(
      await h.run(h.reader.observe(ref('ab'.repeat(50_000)), undefined, undefined)),
    ).toEqual({ seen: 'none' });
    expect(h.calls).toEqual([]);
  });
});
