// Records the length of every base58check decode the address codec performs,
// delegating to the real implementation, so a test can prove long input never reaches it.
const mockBase58Decodes: number[] = [];
jest.mock('@scure/base', () => {
  const actual = jest.requireActual<typeof ScureBase>('@scure/base');
  return {
    ...actual,
    createBase58check: (sha: Parameters<typeof actual.createBase58check>[0]) => {
      const codec = actual.createBase58check(sha);
      return {
        ...codec,
        decode: (value: string) => {
          mockBase58Decodes.push(value.length);
          return codec.decode(value);
        },
      };
    },
  };
});

import { secp256k1 } from '@noble/curves/secp256k1';
import type * as ScureBase from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { utils as tronUtils } from 'tronweb';
import {
  SELECTORS,
  TRANSFER_TOPIC,
  decodeString,
  decodeTransferCall,
  decodeTransferLog,
  decodeUint256,
  encodeBalanceOf,
  encodeTransfer,
} from '../../../src/adapters/tron/abi';
import {
  addressFromPublicKey,
  isTronAddress,
  normalizeTronAddress,
  toBase58Address,
  toHexAddress,
  tronAddressCodec,
} from '../../../src/adapters/tron/address';
import { transferAmount, tronwebCodec } from '../../../src/adapters/tron/codec';
import type { TronRawData, TronTransferContract } from '../../../src/adapters/tron/types';
import { fromHex, toHex, utf8ToBytes } from '../../../src/core/util/bytes';
import { encodeWireRaw } from './support/node';
import { decodeRawData, encodeRawData, encodeTransaction } from './support/protobuf';
import {
  KEY,
  KEY_ADDRESS,
  KEY_HEX,
  KEY_PUBLIC,
  MAINNET_TICKS,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
  VECTORS,
} from './support/vectors';

describe('Tron addresses (SDK-free, strict)', () => {
  it('derives the account from 33- and 65-byte keys, matching tronweb', () => {
    const full = secp256k1.getPublicKey(KEY, false);
    expect(addressFromPublicKey(KEY_PUBLIC)).toBe(KEY_ADDRESS);
    expect(addressFromPublicKey(full)).toBe(KEY_ADDRESS);
    expect(tronUtils.address.fromPrivateKey(KEY)).toBe(KEY_ADDRESS);
    expect(tronAddressCodec.fromPublicKey(KEY_PUBLIC)).toEqual({
      canonical: KEY_ADDRESS,
      display: KEY_ADDRESS,
      variant: { hex: KEY_HEX },
    });
  });

  it('refuses keys tronweb would hash as they are', () => {
    const full = secp256k1.getPublicKey(KEY, false);
    const offCurve = Uint8Array.from(full);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    for (const key of [
      fromHex(KEY), // 32 bytes: a private key, never a public key
      full.subarray(1), // 64 raw bytes
      Uint8Array.from([0x05, ...full.subarray(1)]),
      offCurve,
      new Uint8Array(),
    ]) {
      expect(() => addressFromPublicKey(key)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    }
  });

  it('converts between base58 and hex consistently, both ways', () => {
    for (const [base58, hex] of [
      [KEY_ADDRESS, KEY_HEX],
      [RECIPIENT, RECIPIENT_HEX],
      [USDT, USDT_HEX],
    ] as const) {
      expect(toHexAddress(base58)).toBe(hex);
      expect(toBase58Address(hex)).toBe(base58);
      expect(toBase58Address(hex.toUpperCase())).toBe(base58);
      expect(tronUtils.address.toHex(base58).toLowerCase()).toBe(hex);
      expect(normalizeTronAddress(hex).canonical).toBe(base58);
    }
    expect(
      tronAddressCodec.format?.(normalizeTronAddress(KEY_ADDRESS), { hex: true }),
    ).toBe(KEY_HEX);
  });

  it('accepts exactly what the strict rules allow', () => {
    const bad = [
      KEY_ADDRESS.slice(0, -1) + (KEY_ADDRESS.endsWith('z') ? 'y' : 'z'), // checksum
      KEY_ADDRESS.toLowerCase(),
      `0x${KEY_HEX.slice(2)}`, // an EVM address
      KEY_HEX.slice(2), // 20 bytes
      `42${KEY_HEX.slice(2)}`, // another prefix
      `${KEY_HEX}00`,
      ' ' + KEY_ADDRESS,
      '',
      // A valid base58check of 21 bytes that starts with T, but with prefix 0x42
      'TdMt8op2hj6poePWL6HTfNydgs2fxjHRrM',
    ];
    for (const value of bad) {
      expect(isTronAddress(value)).toBe(false);
      expect(tronUtils.crypto.isAddressValid(value) && /^T/.test(value)).toBe(false);
    }
    expect(isTronAddress(KEY_ADDRESS)).toBe(true);
    expect(isTronAddress(KEY_HEX.toUpperCase())).toBe(true);
  });

  it('never base58-decodes an input longer than an address', () => {
    mockBase58Decodes.length = 0;
    // 43 characters first: a regression then fails fast, before the quadratic 100,000.
    for (const value of [
      `T${'1'.repeat(42)}`,
      `T${'1'.repeat(99_999)}`,
      `41${'0'.repeat(99_998)}`,
    ]) {
      expect(isTronAddress(value)).toBe(false);
      expect(() => normalizeTronAddress(value)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'not a Tron address',
        }),
      );
      expect(mockBase58Decodes).toEqual([]);
    }
    // The spy sees the decoder: a real address reaches it once.
    expect(isTronAddress(KEY_ADDRESS)).toBe(true);
    expect(mockBase58Decodes).toEqual([34]);
  });
});

describe('TRC-20 ABI (SDK-free)', () => {
  it('pins the selectors and the Transfer topic with keccak-256', () => {
    const k = (s: string) => toHex(keccak_256(utf8ToBytes(s)));
    expect(SELECTORS.transfer).toBe(k('transfer(address,uint256)').slice(0, 8));
    expect(SELECTORS.balanceOf).toBe(k('balanceOf(address)').slice(0, 8));
    expect(SELECTORS.decimals).toBe(k('decimals()').slice(0, 8));
    expect(SELECTORS.symbol).toBe(k('symbol()').slice(0, 8));
    expect(TRANSFER_TOPIC).toBe(k('Transfer(address,address,uint256)'));
  });

  it('encodes and decodes the calls and events the driver uses', () => {
    const data = encodeTransfer(RECIPIENT, 2_500_000n);
    expect(data).toBe((VECTORS[1]?.raw.contract as { data: string }).data);
    expect(decodeTransferCall(data)).toEqual({ to: RECIPIENT_HEX, amount: 2_500_000n });
    expect(decodeTransferCall(`${data}00`)).toBeNull();
    expect(encodeBalanceOf(KEY_ADDRESS)).toBe(
      `70a08231000000000000000000000000${KEY_HEX.slice(2)}`,
    );
    expect(() => encodeTransfer(RECIPIENT, -1n)).toThrow(
      expect.objectContaining({ code: 'INVALID_AMOUNT' }),
    );
    expect(decodeUint256('0'.repeat(63) + '6')).toBe(6n);
    expect(() => decodeUint256('')).toThrow(TypeError);
    expect(
      decodeString(
        '0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '5553445400000000000000000000000000000000000000000000000000000000',
      ),
    ).toBe('USDT');
    expect(() => decodeString('00'.repeat(64))).toThrow(TypeError);
    // A linear check, so an 8M-character answer reads
    // or is refused with the function's own TypeError, never a stack overflow.
    const word = (n: number) => n.toString(16).padStart(64, '0');
    const bytes = 4_194_304;
    const long = `${word(32)}${word(bytes)}${'61'.repeat(bytes)}`;
    expect(decodeString(long)).toHaveLength(bytes);
    for (const bad of [
      `${long.slice(0, -1)}g`, // not hex at the very end
      `${long}00`, // not a whole number of words
      `${word(32)}${word(0)}`.slice(0, 126), // under two words
      word(32), // one word
      `${word(32)}${'g'.repeat(64)}`, // a length that is not hex
      `${word(32)}${word(2)}${'4f4b'.padEnd(62, '0')}zz`, // not hex past the string's bytes
      '',
    ]) {
      expect(() => decodeString(bad)).toThrow(TypeError);
    }
    expect(decodeString(`${word(32)}${word(2)}${'4F4B'.padEnd(64, '0')}`)).toBe('OK');
    const log = {
      topics: [
        TRANSFER_TOPIC,
        `000000000000000000000000${KEY_HEX.slice(2)}`,
        `000000000000000000000000${RECIPIENT_HEX.slice(2)}`,
      ],
      data: 5n.toString(16).padStart(64, '0'),
    };
    expect(decodeTransferLog(log)).toEqual({
      from: KEY_HEX,
      to: RECIPIENT_HEX,
      amount: 5n,
    });
    expect(decodeTransferLog({ ...log, topics: log.topics.slice(0, 2) })).toBeNull();
  });

  it('encodes a uint256 amount up to its maximum and refuses the rest', () => {
    const max = (1n << 256n) - 1n;
    expect(encodeTransfer(RECIPIENT, max).slice(72)).toBe('f'.repeat(64));
    expect(decodeTransferCall(encodeTransfer(RECIPIENT, max))?.amount).toBe(max);
    expect(encodeTransfer(RECIPIENT, 0n).slice(72)).toBe('0'.repeat(64));
    for (const amount of [max + 1n, -1n]) {
      expect(() => encodeTransfer(RECIPIENT, amount)).toThrow(
        expect.objectContaining({
          code: 'INVALID_AMOUNT',
          message: 'amount does not fit in a uint256',
        }),
      );
    }
  });

  it('refuses long inputs by their length', () => {
    const data = encodeTransfer(RECIPIENT, 5n);
    expect(decodeTransferCall(`${data}${'0'.repeat(100_000 - data.length)}`)).toBeNull();
    expect(() => decodeUint256('0'.repeat(100_000))).toThrow(TypeError);
    expect(
      decodeTransferLog({
        topics: Array.from({ length: 100_000 }, () => TRANSFER_TOPIC),
        data: '0'.repeat(64),
      }),
    ).toBeNull();
  });
});

/** A protobuf varint as hex, for splicing hand-made fields into raw bytes. */
function varintHex(value: bigint): string {
  let hex = '';
  let v = value;
  do {
    const byte = Number(v & 0x7fn) | (v > 0x7fn ? 0x80 : 0);
    hex += byte.toString(16).padStart(2, '0');
    v >>= 7n;
  } while (v > 0n);
  return hex;
}

/**
 * The smallest `Transaction.raw` `transferAmount` reads: field 11 → `Contract` (type 1) →
 * `Any` field 2 → TransferContract field 3, holding the given varint bytes as the amount.
 */
function minimalTransfer(amountVarint: string): string {
  const wrap = (key: string, body: string) =>
    `${key}${(body.length / 2).toString(16).padStart(2, '0')}${body}`;
  return wrap('5a', `0801${wrap('12', wrap('12', `18${amountVarint}`))}`);
}

function transferVector(): TronRawData & { readonly contract: TronTransferContract } {
  const raw = VECTORS[0]?.raw;
  const contract = raw?.contract;
  if (!raw || contract?.type !== 'TransferContract') throw new Error('vector');
  return { ...raw, contract };
}

function triggerVector(): TronRawData {
  const raw = VECTORS[1]?.raw;
  if (!raw || raw.contract.type !== 'TriggerSmartContract') throw new Error('vector');
  return raw;
}

describe('tronwebCodec', () => {
  it.each(VECTORS)('encodes $name exactly like the independent encoder', (v) => {
    expect(tronwebCodec.encodeRaw(v.raw)).toBe(v.rawHex);
    expect(encodeRawData(v.raw)).toBe(v.rawHex);
    expect(toHex(sha256(fromHex(v.rawHex)))).toBe(v.txId);
    expect(encodeTransaction(v.rawHex, [v.signature])).toBe(v.signed);
  });

  it.each(VECTORS)('decodes $name back to the same fields', (v) => {
    expect(tronwebCodec.decodeRaw(v.rawHex)).toEqual(v.raw);
    expect(decodeRawData(v.rawHex)).toEqual(v.raw);
  });

  it('refuses bytes this model does not carry, and junk', () => {
    const withRefNum = `${VECTORS[0]?.rawHex.slice(0, 8)}1801${VECTORS[0]?.rawHex.slice(8)}`;
    for (const hex of ['', '0a00', 'zz', withRefNum, `${VECTORS[0]?.rawHex}00`]) {
      expect(() => tronwebCodec.decodeRaw(hex)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('refuses amounts protobuf would round (above 2^53 - 1)', () => {
    const raw = VECTORS[0]?.raw;
    const contract = raw?.contract;
    if (!raw || contract?.type !== 'TransferContract') throw new Error('vector');
    expect(() =>
      tronwebCodec.encodeRaw({ ...raw, contract: { ...contract, amount: 2n ** 53n } }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
  });

  it('encodes every integer field up to 2^53 - 1 and refuses the rest', () => {
    const transfer = transferVector();
    const trigger = triggerVector();
    const MAX = Number.MAX_SAFE_INTEGER;
    const amount = (value: bigint): TronRawData => ({
      ...transfer,
      contract: { ...transfer.contract, amount: value },
    });
    for (const raw of [
      amount(BigInt(MAX)),
      { ...trigger, expiration: MAX },
      { ...trigger, timestamp: MAX },
      { ...trigger, feeLimit: MAX },
    ]) {
      expect(tronwebCodec.encodeRaw(raw)).toBe(encodeRawData(raw));
    }
    const refused: readonly (readonly [TronRawData, string])[] = [
      [amount(BigInt(MAX) + 1n), 'INVALID_AMOUNT'],
      [amount(2n ** 64n + 5n), 'INVALID_AMOUNT'],
      [amount(-1n), 'INVALID_AMOUNT'],
      ...(['expiration', 'timestamp', 'feeLimit'] as const).flatMap((field) =>
        [MAX + 1, -1, 1.5, Number.NaN].map(
          (value) => [{ ...trigger, [field]: value }, 'INVALID_INTENT'] as const,
        ),
      ),
    ];
    for (const [raw, code] of refused) {
      let error: unknown;
      try {
        tronwebCodec.encodeRaw(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code });
      // A fixed text: never the value, which has digits in every case above.
      expect((error as Error).message).not.toMatch(/\d/);
    }
  });

  it('keeps the independent encoder to non-negative int64 values', () => {
    const transfer = transferVector();
    const amount = (value: bigint): TronRawData => ({
      ...transfer,
      contract: { ...transfer.contract, amount: value },
    });
    const max = (1n << 63n) - 1n;
    expect(decodeRawData(encodeRawData(amount(max))).contract).toMatchObject({
      amount: max,
    });
    for (const value of [max + 1n, 2n ** 64n + 5n, -1n]) {
      expect(() => encodeRawData(amount(value))).toThrow('varint out of range');
    }
  });

  it('reads a TRX amount above 2^53 exactly from the bytes, where tronweb rounds', () => {
    const raw = VECTORS[0]?.raw;
    const contract = raw?.contract;
    if (!raw || contract?.type !== 'TransferContract') throw new Error('vector');
    const huge = { ...raw, contract: { ...contract, amount: 2n ** 60n + 1n } };
    const hex = encodeRawData(huge);
    expect(transferAmount(hex)).toBe(2n ** 60n + 1n);
    expect(tronwebCodec.readRaw(hex)).toEqual(huge);
    expect(transferAmount(VECTORS[1]?.rawHex ?? '')).toBeNull();
    expect(transferAmount('zz')).toBeNull();
  });

  it('reads an amount only from well-formed bytes with a single contract', () => {
    const int64Max = (1n << 63n) - 1n;
    expect(transferAmount(minimalTransfer(varintHex(int64Max)))).toBe(int64Max);
    // 2^63 is a negative int64, and 2^64 does not fit in a varint's 64 bits.
    expect(transferAmount(minimalTransfer(varintHex(1n << 63n)))).toBeNull();
    expect(transferAmount(minimalTransfer(varintHex(1n << 64n)))).toBeNull();
    // Fixed-width fields (a fixed64 field 20, a fixed32 field 21) are skipped whole, and
    // refused when truncated.
    const hex = VECTORS[0]?.rawHex ?? '';
    expect(transferAmount(`${hex}a101${'00'.repeat(8)}ad01${'00'.repeat(4)}`)).toBe(
      1_500_000n,
    );
    expect(transferAmount(`${hex}a101${'00'.repeat(7)}`)).toBeNull();
    expect(transferAmount(`${hex}ad01${'00'.repeat(3)}`)).toBeNull();
    // A varint in any field (here field 20) holds at most 64 bits: 2^64 - 1, not 2^64.
    expect(transferAmount(`${hex}a001${varintHex(2n ** 64n - 1n)}`)).toBe(1_500_000n);
    expect(transferAmount(`${hex}a001${varintHex(2n ** 64n)}`)).toBeNull();
    // A second contract (java-tron takes exactly one): never a mix of the two.
    const transfer = transferVector();
    const huge = {
      ...transfer,
      contract: { ...transfer.contract, amount: 2n ** 60n + 1n },
    };
    const second = encodeRawData({
      refBlockBytes: '',
      refBlockHash: '',
      expiration: 0,
      timestamp: 0,
      contract: transfer.contract,
    });
    const twice = `${encodeRawData(huge)}${second}`;
    expect(transferAmount(twice)).toBeNull();
    expect(tronwebCodec.readRaw(twice)).toBeNull();
    // A singular field repeated inside the contract (the amount, twice) is never guessed at.
    expect(transferAmount(minimalTransfer(`05${'18'}06`))).toBeNull();
    // `auths` (raw field 9) is repeated, unused client metadata: two of them still read.
    const auth = '4a050a030a0161'; // authority { account { name: "a" } }
    const withAuths = `${encodeRawData(huge)}${auth}${auth}`;
    expect(transferAmount(withAuths)).toBe(2n ** 60n + 1n);
    expect(tronwebCodec.readRaw(withAuths)).toEqual(huge);
  });

  it('refuses two contracts even when both amounts are exact', () => {
    const transfer = transferVector();
    const other = { ...transfer.contract, to: KEY_HEX, amount: 7n };
    const second = encodeRawData({
      refBlockBytes: '',
      refBlockHash: '',
      expiration: 0,
      timestamp: 0,
      contract: other,
    });
    for (const first of [VECTORS[0]?.rawHex ?? '', VECTORS[1]?.rawHex ?? '']) {
      const pair = `${first}${second}`;
      expect(tronwebCodec.readRaw(pair)).toBeNull();
      expect(() => tronwebCodec.decodeRaw(pair)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
    expect(transferAmount(`${VECTORS[0]?.rawHex ?? ''}${second}`)).toBeNull();
  });

  it("reads raw bytes up to java-tron's 500 KiB and refuses longer hex before decoding", () => {
    const transfer = transferVector();
    const withMemo = (bytes: number): TronRawData => ({
      ...transfer,
      data: '61'.repeat(bytes),
    });
    // The memo that makes the raw bytes exactly 500 × 1024 (its length prefix stays 3 bytes).
    const fill = 500_000 + 512_000 - encodeRawData(withMemo(500_000)).length / 2;
    const max = encodeRawData(withMemo(fill));
    expect(max.length).toBe(1_024_000);
    expect(transferAmount(max)).toBe(1_500_000n);
    expect(tronwebCodec.readRaw(max)).toEqual(withMemo(fill));
    expect(tronwebCodec.decodeRaw(max)).toEqual(withMemo(fill));
    const over = encodeRawData(withMemo(fill + 1));
    expect(over.length).toBe(1_024_002);
    expect(transferAmount(over)).toBeNull();
    expect(tronwebCodec.readRaw(over)).toBeNull();
    expect(() => tronwebCodec.decodeRaw(over)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it('decodes strictly, but reads unbounded client metadata leniently', () => {
    const transfer = transferVector();
    const hex = VECTORS[0]?.rawHex ?? '';
    const expiration = `40${varintHex(1_790_000_060_000n)}`;
    const timestamp = `70${varintHex(1_790_000_000_000n)}`;
    expect(hex).toContain(expiration);
    expect(hex).toContain(timestamp);
    const minusOne = varintHex(2n ** 64n - 1n); // int64 -1
    const unsafe = varintHex(2n ** 60n + 1n);
    // java-tron bounds `expiration` (validateCommon), so an unsafe one is not a chain read.
    const badExpiration = hex.replace(expiration, `40${unsafe}`);
    expect(tronwebCodec.readRaw(badExpiration)).toBeNull();
    // `timestamp` is unbounded and informational: read as tronweb holds it.
    const lenient: readonly (readonly [string, TronRawData])[] = [
      [hex.replace(timestamp, `70${minusOne}`), { ...transfer, timestamp: -1 }],
      [
        hex.replace(timestamp, `70${unsafe}`),
        { ...transfer, timestamp: Number(2n ** 60n + 1n) },
      ],
      // A TRX transfer's `fee_limit` is unbounded too (only the VM checks it); a value a
      // number cannot hold exactly, or a negative one, is left out, never rounded.
      [`${hex}9001${unsafe}`, transfer],
      [`${hex}9001${minusOne}`, transfer],
    ];
    for (const [bytes, read] of lenient) {
      expect(tronwebCodec.readRaw(bytes)).toEqual(read);
    }
    for (const bytes of [badExpiration, ...lenient.map(([bytes]) => bytes)]) {
      expect(() => tronwebCodec.decodeRaw(bytes)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('reads a real mainnet transfer whose timestamp is .NET ticks', () => {
    // Block 86,615,431, txid a362c1f34d02…: see MAINNET_TICKS. Refusing it would stall
    // every history or scan that reaches it.
    const v = MAINNET_TICKS;
    expect(toHex(sha256(fromHex(v.rawHex)))).toBe(v.txId);
    expect(v.timestamp > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(tronwebCodec.readRaw(v.rawHex)).toEqual(v.raw);
    expect(transferAmount(v.rawHex)).toBe(200_800n);
    // Strict decoding refuses it: we never encode a timestamp above 2^53 - 1.
    expect(() => tronwebCodec.decodeRaw(v.rawHex)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it("reads a call's TRX and TRC-10 value exactly, and never encodes one", () => {
    const raw: TronRawData = {
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
    const values = { callValue: 2n ** 60n + 1n, callTokenValue: 7n, tokenId: 1_000_001n };
    // tronweb reads these int64s as numbers (2^60 + 1 would round): read from the bytes.
    expect(tronwebCodec.readRaw(encodeWireRaw(raw, values))).toEqual({
      ...raw,
      contract: { ...raw.contract, ...values },
    });
    expect(tronwebCodec.readRaw(encodeWireRaw(raw, { callValue: 3n }))).toEqual({
      ...raw,
      contract: { ...raw.contract, callValue: 3n },
    });
    // Zero values are absent on the wire, and in the model.
    expect(tronwebCodec.readRaw(encodeWireRaw(raw))).toEqual(raw);
    // A negative value is never in a block (VMActuator refuses it).
    expect(tronwebCodec.readRaw(encodeWireRaw(raw, { callValue: -1n }))).toBeNull();
    expect(tronwebCodec.readRaw(encodeWireRaw(raw, { tokenId: -5n }))).toBeNull();
    // The driver never writes a value, and strict decoding refuses bytes that carry one.
    for (const extra of [
      { callValue: 1n },
      { callTokenValue: 1n },
      { tokenId: 1_000_001n },
    ]) {
      expect(() =>
        tronwebCodec.encodeRaw({ ...raw, contract: { ...raw.contract, ...extra } }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT' }));
    }
    expect(() => tronwebCodec.decodeRaw(encodeWireRaw(raw, { callValue: 1n }))).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });
});
