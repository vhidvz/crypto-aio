/**
 * An independent, test-only protobuf codec for the Tron messages the driver builds
 * (`Transaction`, `Transaction.raw`, TransferContract, TriggerSmartContract), written from
 * Tron's `core/Tron.proto` and `core/contract/*.proto`. It cross-checks tronweb's bytes
 * and powers the scripted node, so the node never decodes with the code under
 * test. Unknown fields are refused, which is stricter than java-tron and fine for a fake.
 */
import { fromHex, toHex, utf8ToBytes } from '../../../../src/core/util/bytes';
import type { TronContract, TronRawData } from '../../../../src/adapters/tron/types';

/** Every varint field here is a non-negative `int64` (or an enum, or a length). */
const INT64_MAX = (1n << 63n) - 1n;

function varint(value: bigint): number[] {
  // Refuse, never wrap. The text never contains the value.
  if (value < 0n || value > INT64_MAX) throw new TypeError('varint out of range');
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

const tag = (field: number, wire: number): number[] =>
  varint(BigInt((field << 3) | wire));
const int = (field: number, value: bigint): number[] =>
  value === 0n ? [] : [...tag(field, 0), ...varint(value)];
const bytes = (field: number, value: Uint8Array): number[] =>
  value.length === 0 ? [] : [...tag(field, 2), ...varint(BigInt(value.length)), ...value];

const TYPES = { TransferContract: 1, TriggerSmartContract: 31 } as const;

function contractBytes(contract: TronContract): Uint8Array {
  const value =
    contract.type === 'TransferContract'
      ? [
          ...bytes(1, fromHex(contract.owner)),
          ...bytes(2, fromHex(contract.to)),
          ...int(3, contract.amount),
        ]
      : [
          ...bytes(1, fromHex(contract.owner)),
          ...bytes(2, fromHex(contract.contract)),
          ...bytes(4, fromHex(contract.data)),
        ];
  const any = [
    ...bytes(1, utf8ToBytes(`type.googleapis.com/protocol.${contract.type}`)),
    ...bytes(2, Uint8Array.from(value)),
  ];
  return Uint8Array.from([
    ...int(1, BigInt(TYPES[contract.type])),
    ...bytes(2, Uint8Array.from(any)),
  ]);
}

export function encodeRawData(raw: TronRawData): string {
  return toHex(
    Uint8Array.from([
      ...bytes(1, fromHex(raw.refBlockBytes)),
      ...bytes(4, fromHex(raw.refBlockHash)),
      ...int(8, BigInt(raw.expiration)),
      ...(raw.data !== undefined ? bytes(10, fromHex(raw.data)) : []),
      ...bytes(11, contractBytes(raw.contract)),
      ...int(14, BigInt(raw.timestamp)),
      ...(raw.feeLimit !== undefined ? int(18, BigInt(raw.feeLimit)) : []),
    ]),
  );
}

/** `Transaction { raw_data = 1; repeated bytes signature = 2; }`. */
export function encodeTransaction(rawHex: string, signatures: readonly string[]): string {
  return toHex(
    Uint8Array.from([
      ...bytes(1, fromHex(rawHex)),
      ...signatures.flatMap((s) => bytes(2, fromHex(s))),
    ]),
  );
}

type Field = {
  readonly field: number;
  readonly wire: number;
  readonly value: bigint | Uint8Array;
};

function fields(data: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const read = (): bigint => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = data[i++];
      if (byte === undefined || shift > 63n) throw new TypeError('truncated varint');
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
  };
  while (i < data.length) {
    const key = read();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ field, wire, value: read() });
    else if (wire === 2) {
      const length = Number(read());
      if (i + length > data.length) throw new TypeError('truncated field');
      out.push({ field, wire, value: data.subarray(i, i + length) });
      i += length;
    } else throw new TypeError(`unsupported wire type ${wire}`);
  }
  return out;
}

function only(list: Field[], allowed: readonly number[]): Map<number, Field> {
  const map = new Map<number, Field>();
  for (const f of list) {
    if (!allowed.includes(f.field) || map.has(f.field)) {
      throw new TypeError(`unexpected field ${f.field}`);
    }
    map.set(f.field, f);
  }
  return map;
}

const asBytes = (f: Field | undefined): Uint8Array =>
  f === undefined ? new Uint8Array() : f.value instanceof Uint8Array ? f.value : fail();
const asInt = (f: Field | undefined): bigint =>
  f === undefined ? 0n : typeof f.value === 'bigint' ? f.value : fail();
function fail(): never {
  throw new TypeError('wrong wire type');
}

export function decodeRawData(hex: string): TronRawData {
  const raw = only(fields(fromHex(hex)), [1, 4, 8, 10, 11, 14, 18]);
  const contract = only(fields(asBytes(raw.get(11))), [1, 2]);
  const any = only(fields(asBytes(contract.get(2))), [1, 2]);
  const type = asInt(contract.get(1));
  const value = only(fields(asBytes(any.get(2))), type === 1n ? [1, 2, 3] : [1, 2, 4]);
  const decoded: TronContract =
    type === 1n
      ? {
          type: 'TransferContract',
          owner: toHex(asBytes(value.get(1))),
          to: toHex(asBytes(value.get(2))),
          amount: asInt(value.get(3)),
        }
      : type === 31n
        ? {
            type: 'TriggerSmartContract',
            owner: toHex(asBytes(value.get(1))),
            contract: toHex(asBytes(value.get(2))),
            data: toHex(asBytes(value.get(4))),
          }
        : fail();
  const memo = asBytes(raw.get(10));
  const feeLimit = asInt(raw.get(18));
  return {
    refBlockBytes: toHex(asBytes(raw.get(1))),
    refBlockHash: toHex(asBytes(raw.get(4))),
    expiration: Number(asInt(raw.get(8))),
    timestamp: Number(asInt(raw.get(14))),
    ...(feeLimit > 0n ? { feeLimit: Number(feeLimit) } : {}),
    ...(memo.length > 0 ? { data: toHex(memo) } : {}),
    contract: decoded,
  };
}

export function decodeTransaction(hex: string): {
  readonly rawHex: string;
  readonly signatures: readonly string[];
} {
  const list = fields(fromHex(hex));
  const raw = list.filter((f) => f.field === 1);
  if (raw.length !== 1 || list.some((f) => f.field !== 1 && f.field !== 2)) {
    throw new TypeError('not a transaction');
  }
  return {
    rawHex: toHex(asBytes(raw[0])),
    signatures: list.filter((f) => f.field === 2).map((f) => toHex(asBytes(f))),
  };
}
