/**
 * A scripted Tron node for tests (test-only, D6): java-tron's HTTP API (`/wallet`,
 * `/walletsolidity`), its JSON-RPC block reads and TronGrid's `/v1` history, served per
 * endpoint through a `FakeFetch`. It models the rules the driver's safety depends on
 * (lesson 8). Fix round 1 checked each rule and text against java-tron GreatVoyage-v4.8.2.2
 * (commit d5c3d1d1fd0cad12f09c4346d6ac937ab2cbb071); the file and method are named at each
 * rule. Where the source could not settle a case, the node is stricter than the chain,
 * never more lenient.
 * - Admission (`Wallet.broadcastTransaction`, then `Manager.pushTransaction` and
 *   `processTransaction`): signature sizes; at least one contract; the expiration against
 *   the next slot; the signature against the owner permission (one key); exactly one
 *   contract; TaPoS; the size with results; the expiration window; duplicates; bandwidth
 *   (the owner must exist; a new account: the size cap, then staked × rate or the creation
 *   fee; otherwise staked, then free, then burned); the memo fee; the contract.
 * - Execution in blocks: the same checks against the parent block, where an expiration
 *   before the next slot is refused (`getConsensusLogicOptimization` = 1, as on mainnet).
 *   TRC-20 energy is capped at min(staked + (balance − call value) / price, fee_limit /
 *   price), so a low fee limit is included and fails `OUT_OF_ENERGY`. A refused
 *   transaction changes nothing: java-tron runs each one in its own revoking session.
 * - 3-second slots, solidification `solidDepth` blocks below the head, reorgs of
 *   unsolidified blocks only, and endpoints that lag.
 * It decodes transactions with its own wire reader (below) and recovers signers with
 * `@noble/curves`, never with the code under test. Deterministic: no timers, no
 * `Math.random`, no `Date.now`.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import {
  addressFromPublicKey,
  toBase58Address,
  toHexAddress,
} from '../../../../src/adapters/tron/address';
import type { TronContract, TronRawData } from '../../../../src/adapters/tron/types';
import { fromHex, toHex, utf8ToBytes } from '../../../../src/core/util/bytes';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';
import { encodeTransaction } from './protobuf';

export const GENESIS: Readonly<Record<string, string>> = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  shasta: '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e',
  nile: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
};

export const PARAMS = {
  getTransactionFee: 1_000n,
  getEnergyFee: 100n,
  getCreateAccountFee: 100_000n,
  getCreateNewAccountFeeInSystemContract: 1_000_000n,
  getCreateNewAccountBandwidthRate: 1n,
  getMemoFee: 1_000_000n,
  getMaxFeeLimit: 15_000_000_000n,
  getFreeNetLimit: 600n,
  /** `CommonParameter.maxCreateAccountTxSize`: a new account's transaction, without signatures. */
  getMaxCreateAccountTxSize: 1_000n,
  /** TRX never goes into a contract by a TransferContract (mainnet proposal). */
  getForbidTransferToContract: 1n,
};

/** Energy of a TRC-20 transfer to an existing holder, and the extra for a new holder slot. */
export const TRANSFER_ENERGY = 14_650n;
export const NEW_HOLDER_ENERGY = 15_000n;
/** Energy of a non-payable function's revert when a call carries TRX. */
const NON_PAYABLE_ENERGY = 100n;
/** `Constant.MAXIMUM_TIME_UNTIL_EXPIRATION`. */
const MAX_EXPIRATION_MS = 86_400_000;
/** `Constant.TRANSACTION_MAX_BYTE_SIZE` (500 KiB). */
const MAX_TX_BYTES = 512_000n;
/** `Constant.MAX_RESULT_SIZE_IN_TX`: result bytes counted per contract. */
const MAX_RESULT_SIZE = 64n;
/** `Constant.PER_SIGN_LENGTH` (java-tron accepts up to `MAX_PER_SIGN_LENGTH` = 68). */
const SIGNATURE_BYTES = 65;
/** `DynamicPropertiesStore` default `TOTAL_SIGN_NUM`. */
const TOTAL_SIGN_NUM = 5;
const SLOT_MS = 3_000;
/** TronGrid's page limit. */
const HISTORY_MAX_LIMIT = 200;
/** `DecodeUtil.addressValid`: 21 bytes with the `0x41` prefix. */
const ADDRESS = /^41[0-9a-f]{40}$/;
const INT64_SPAN = 1n << 64n;
const CONTRACT_TYPES: Readonly<Record<string, TronContract['type']>> = {
  '1': 'TransferContract',
  '31': 'TriggerSmartContract',
};

export interface NodeOptions {
  readonly clock: FakeClock;
  /** Which genesis id block 0 carries (default nile). */
  readonly network?: string;
  /** Blocks between the head and the latest solidified block (default 19). */
  readonly solidDepth?: number;
  readonly params?: Partial<typeof PARAMS>;
}

interface Account {
  balance: bigint;
  freeNetUsed: bigint;
  stakedNet: bigint;
  netUsed: bigint;
  stakedEnergy: bigint;
  energyUsed: bigint;
}

export type TokenMode = 'standard' | 'no-log' | 'reverting-metadata' | 'fee';

interface Token {
  readonly symbol: string;
  readonly decimals: number;
  readonly mode: TokenMode;
  readonly balances: Map<string, bigint>;
}

interface State {
  readonly accounts: Map<string, Account>;
  readonly tokens: Map<string, Token>;
}

interface Receipt {
  readonly contractRet: 'SUCCESS' | 'REVERT' | 'OUT_OF_ENERGY';
  readonly fee: bigint;
  readonly netUsage: bigint;
  readonly netFee: bigint;
  readonly energyUsage: bigint;
  readonly energyFee: bigint;
  /** The call's return data (`contractResult`), hex. */
  readonly returned: string;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}

/** Fields of the signed bytes that `TronRawData` does not carry, read exactly (int64). */
export interface WireFields {
  readonly expiration: bigint;
  readonly timestamp: bigint;
  readonly feeLimit: bigint;
  readonly refBlockNum: bigint;
  readonly callValue: bigint;
  /** `TriggerSmartContract.call_token_value` and `token_id` (TRC-10). */
  readonly callTokenValue: bigint;
  readonly tokenId: bigint;
  readonly permissionId: bigint;
}

export interface StoredTx {
  readonly id: string;
  /** `getRawData().toByteArray()`: the raw data re-serialized, which the txID hashes. */
  readonly rawHex: string;
  readonly raw: TronRawData;
  readonly wire: WireFields;
  /** How many contracts the raw data holds (java-tron includes only exactly one). */
  readonly contracts: number;
  readonly signatures: readonly string[];
  /** The serialized size without `ret`, as java-tron counts it. */
  readonly size: bigint;
  /** Bandwidth: the size plus 64 result bytes (`BandwidthProcessor.consume`). */
  readonly bytes: bigint;
  receipt?: Receipt;
  blockNumber?: number;
}

interface Block {
  readonly number: number;
  readonly id: string;
  readonly parentId: string;
  readonly timestamp: number;
  readonly txs: StoredTx[];
  readonly state: State;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `Wallet.broadcastTransaction`'s answers, verified. */
const invalid = (message: string) =>
  new Refusal('CONTRACT_VALIDATE_ERROR', `Contract validate error : ${message}`);
const badSignature = (message: string) =>
  new Refusal('SIGERROR', `Validate signature error: ${message}`);
const expired = () => new Refusal('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired');
const insufficient = () =>
  new Refusal('BANDWITH_ERROR', 'Account resource insufficient error.');

const emptyAccount = (): Account => ({
  balance: 0n,
  freeNetUsed: 0n,
  stakedNet: 0n,
  netUsed: 0n,
  stakedEnergy: 0n,
  energyUsed: 0n,
});

const cloneState = (state: State): State => ({
  accounts: new Map([...state.accounts].map(([k, v]) => [k, { ...v }])),
  tokens: new Map(
    [...state.tokens].map(([k, v]) => [k, { ...v, balances: new Map(v.balances) }]),
  ),
});

const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const hexOf = (text: string): string => toHex(utf8ToBytes(text));
const omitZero = (key: string, value: bigint): Record<string, bigint> =>
  value === 0n ? {} : { [key]: value };
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** JSON with exact integers, as java-tron writes them: a bigint is a bare number literal. */
function exactJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `#bigint:${v}#` : v,
  ).replace(/"#bigint:(-?\d+)#"/g, '$1');
}

// ---- the node's wire codec -------------------------------------------------------------

/** Fields java-tron accepts that the driver's model does not carry. */
export interface WireExtras {
  /** `TriggerSmartContract.call_value` (field 3), sun; negative is written as int64. */
  readonly callValue?: bigint;
  /** `TriggerSmartContract.call_token_value` (field 5), a TRC-10 amount. */
  readonly callTokenValue?: bigint;
  /** `TriggerSmartContract.token_id` (field 6), a TRC-10 id. */
  readonly tokenId?: bigint;
  /** `Transaction.Contract.Permission_id` (field 5). */
  readonly permissionId?: number;
  /** `Transaction.raw.ref_block_num` (field 3). */
  readonly refBlockNum?: bigint;
  /** `Transaction.raw.timestamp` (field 14), exact; replaces `raw.timestamp`. */
  readonly timestamp?: bigint;
  /** Contracts after the first (java-tron refuses more than one). */
  readonly moreContracts?: readonly TronContract[];
}

/** One `Transaction.Result` (`ret`, field 5 of `Transaction`): enum values as numbers. */
export interface WireResult {
  readonly fee?: bigint;
  /** `code`: 0 SUCESS, 1 FAILED. */
  readonly ret?: number;
  /** `contractResult`: 1 SUCCESS, 2 REVERT, 10 OUT_OF_ENERGY, … */
  readonly contractRet?: number;
}

/** `Transaction.Result` enum names (Tron.proto), as `JsonFormat` prints them. */
const RESULT_CODES = ['SUCESS', 'FAILED'];
const CONTRACT_RESULTS = [
  'DEFAULT',
  'SUCCESS',
  'REVERT',
  'BAD_JUMP_DESTINATION',
  'OUT_OF_MEMORY',
  'PRECOMPILED_CONTRACT',
  'STACK_TOO_SMALL',
  'STACK_TOO_LARGE',
  'ILLEGAL_OPERATION',
  'STACK_OVERFLOW',
  'OUT_OF_ENERGY',
  'OUT_OF_TIME',
  'JVM_STACK_OVER_FLOW',
  'UNKNOWN',
  'TRANSFER_FAILED',
  'INVALID_CODE',
];

function wireVarint(value: bigint): number[] {
  let v = value < 0n ? value + INT64_SPAN : value;
  if (v < 0n || v >= INT64_SPAN) throw new TypeError('varint out of range');
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}
const wireTag = (field: number, wire: number): number[] =>
  wireVarint(BigInt((field << 3) | wire));
const wireInt = (field: number, value: bigint): number[] =>
  value === 0n ? [] : [...wireTag(field, 0), ...wireVarint(value)];
const wireBytes = (field: number, value: Uint8Array): number[] =>
  value.length === 0
    ? []
    : [...wireTag(field, 2), ...wireVarint(BigInt(value.length)), ...value];
/** An entry of a repeated message field: written even when empty. */
const wireEntry = (field: number, value: Uint8Array | readonly number[]): number[] => [
  ...wireTag(field, 2),
  ...wireVarint(BigInt(value.length)),
  ...value,
];

function contractBytes(c: TronContract, extras: WireExtras): number[] {
  const value =
    c.type === 'TransferContract'
      ? [
          ...wireBytes(1, fromHex(c.owner)),
          ...wireBytes(2, fromHex(c.to)),
          ...wireInt(3, c.amount),
        ]
      : [
          ...wireBytes(1, fromHex(c.owner)),
          ...wireBytes(2, fromHex(c.contract)),
          ...wireInt(3, extras.callValue ?? 0n),
          ...wireBytes(4, fromHex(c.data)),
          ...wireInt(5, extras.callTokenValue ?? 0n),
          ...wireInt(6, extras.tokenId ?? 0n),
        ];
  const any = [
    ...wireBytes(1, utf8ToBytes(`type.googleapis.com/protocol.${c.type}`)),
    ...wireBytes(2, Uint8Array.from(value)),
  ];
  return [
    ...wireInt(1, c.type === 'TransferContract' ? 1n : 31n),
    ...wireBytes(2, Uint8Array.from(any)),
    ...wireInt(5, BigInt(extras.permissionId ?? 0)),
  ];
}

/**
 * `Transaction.raw` bytes with the extras java-tron accepts, in field order (canonical):
 * without extras, the test codec's `encodeRawData` bytes. The extras of a contract apply to
 * the first one only.
 */
export function encodeWireRaw(raw: TronRawData, extras: WireExtras = {}): string {
  return toHex(
    Uint8Array.from([
      ...wireBytes(1, fromHex(raw.refBlockBytes)),
      ...wireInt(3, extras.refBlockNum ?? 0n),
      ...wireBytes(4, fromHex(raw.refBlockHash)),
      ...wireInt(8, BigInt(raw.expiration)),
      ...(raw.data !== undefined ? wireBytes(10, fromHex(raw.data)) : []),
      ...wireEntry(11, contractBytes(raw.contract, extras)),
      ...(extras.moreContracts ?? []).flatMap((c) => wireEntry(11, contractBytes(c, {}))),
      ...wireInt(14, extras.timestamp ?? BigInt(raw.timestamp)),
      ...(raw.feeLimit !== undefined ? wireInt(18, BigInt(raw.feeLimit)) : []),
    ]),
  );
}

/** A signed `Transaction` with `ret` entries (field 5), which java-tron parses and clears. */
export function encodeWireTransaction(
  rawHex: string,
  signatures: readonly string[],
  results: readonly WireResult[] = [],
): string {
  return toHex(
    Uint8Array.from([
      ...wireBytes(1, fromHex(rawHex)),
      ...signatures.flatMap((s) => wireEntry(2, fromHex(s))),
      ...results.flatMap((r) =>
        wireEntry(5, [
          ...wireInt(1, r.fee ?? 0n),
          ...wireInt(2, BigInt(r.ret ?? 0)),
          ...wireInt(3, BigInt(r.contractRet ?? 0)),
        ]),
      ),
    ]),
  );
}

type WireValue = bigint | Uint8Array;
type Message = Map<number, WireValue[]>;

/**
 * One protobuf message (wire types 0 and 2 only); any other wire type, and a field outside
 * `allowed` (null: any field), throws.
 */
function readMessage(data: Uint8Array, allowed: readonly number[] | null): Message {
  const out: Message = new Map();
  let i = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const byte = data[i++];
      if (byte === undefined) throw new TypeError('truncated varint');
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result & (INT64_SPAN - 1n);
    }
    throw new TypeError('varint over 64 bits');
  };
  while (i < data.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0 || (allowed !== null && !allowed.includes(field))) {
      throw new TypeError(`unexpected field ${field}`);
    }
    let value: WireValue;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = Number(varint());
      if (i + length > data.length) throw new TypeError('truncated field');
      value = data.subarray(i, i + length);
      i += length;
    } else throw new TypeError('unsupported wire type');
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

function single(message: Message, field: number): WireValue | undefined {
  const values = message.get(field) ?? [];
  if (values.length > 1) throw new TypeError(`repeated field ${field}`);
  return values[0];
}
function bytesOf(message: Message, field: number): Uint8Array {
  const value = single(message, field);
  if (value === undefined) return new Uint8Array();
  if (!(value instanceof Uint8Array)) throw new TypeError('wrong wire type');
  return value;
}
/** An int64 field, signed as java-tron reads it. */
function int64Of(message: Message, field: number): bigint {
  const value = single(message, field) ?? 0n;
  if (typeof value !== 'bigint') throw new TypeError('wrong wire type');
  return value >= 1n << 63n ? value - INT64_SPAN : value;
}

interface ContractEntry {
  readonly type: bigint;
  readonly typeUrl: string;
  readonly value: Uint8Array;
  readonly permissionId: bigint;
}

/** What the node reads from a signed transaction. */
interface Signed {
  /** The raw data re-serialized (`getRawData().toByteArray()`), or as sent when unread. */
  readonly rawHex: string;
  readonly signatures: readonly string[];
  /** The input's `ret` entries, which java-tron parses, echoes and then clears. */
  readonly results: readonly Message[];
  /** The raw data's fields, or null when the node does not model them. */
  readonly fields: Message | null;
  readonly contracts: readonly ContractEntry[];
  /** The first contract as the driver's model, or null when the node does not model it. */
  readonly model: { readonly raw: TronRawData; readonly wire: WireFields } | null;
}

class Unparseable extends Error {}

function readContract(bytes: WireValue): ContractEntry {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('wrong wire type');
  const contract = readMessage(bytes, [1, 2, 5]);
  const any = readMessage(bytesOf(contract, 2), [1, 2]);
  return {
    type: int64Of(contract, 1),
    typeUrl: new TextDecoder().decode(bytesOf(any, 1)),
    value: bytesOf(any, 2),
    permissionId: int64Of(contract, 5),
  };
}

/**
 * The raw data as protobuf-java re-serializes it: fields in number order, defaults left
 * out, minimal varints. `Any.value` is opaque bytes and stays as sent.
 */
function canonicalRaw(fields: Message, contracts: readonly ContractEntry[]): string {
  return toHex(
    Uint8Array.from([
      ...wireBytes(1, bytesOf(fields, 1)),
      ...wireInt(3, int64Of(fields, 3)),
      ...wireBytes(4, bytesOf(fields, 4)),
      ...wireInt(8, int64Of(fields, 8)),
      ...wireBytes(10, bytesOf(fields, 10)),
      ...contracts.flatMap((c) =>
        wireEntry(11, [
          ...wireInt(1, c.type),
          ...wireBytes(
            2,
            Uint8Array.from([
              ...wireBytes(1, utf8ToBytes(c.typeUrl)),
              ...wireBytes(2, c.value),
            ]),
          ),
          ...wireInt(5, c.permissionId),
        ]),
      ),
      ...wireInt(14, int64Of(fields, 14)),
      ...wireInt(18, int64Of(fields, 18)),
    ]),
  );
}

function model(
  fields: Message,
  entry: ContractEntry,
): { raw: TronRawData; wire: WireFields } | null {
  const type = CONTRACT_TYPES[entry.type.toString()];
  if (!type || entry.typeUrl !== `type.googleapis.com/protocol.${type}`) return null;
  let contract: TronContract;
  let callValue = 0n;
  let callTokenValue = 0n;
  let tokenId = 0n;
  try {
    if (type === 'TransferContract') {
      const value = readMessage(entry.value, [1, 2, 3]);
      contract = {
        type,
        owner: toHex(bytesOf(value, 1)),
        to: toHex(bytesOf(value, 2)),
        amount: int64Of(value, 3),
      };
    } else {
      const value = readMessage(entry.value, [1, 2, 3, 4, 5, 6]);
      contract = {
        type,
        owner: toHex(bytesOf(value, 1)),
        contract: toHex(bytesOf(value, 2)),
        data: toHex(bytesOf(value, 4)),
      };
      callValue = int64Of(value, 3);
      callTokenValue = int64Of(value, 5);
      tokenId = int64Of(value, 6);
    }
  } catch {
    return null;
  }
  const wire: WireFields = {
    expiration: int64Of(fields, 8),
    timestamp: int64Of(fields, 14),
    feeLimit: int64Of(fields, 18),
    refBlockNum: int64Of(fields, 3),
    callValue,
    callTokenValue,
    tokenId,
    permissionId: entry.permissionId,
  };
  const memo = bytesOf(fields, 10);
  return {
    raw: {
      refBlockBytes: toHex(bytesOf(fields, 1)),
      refBlockHash: toHex(bytesOf(fields, 4)),
      expiration: Number(wire.expiration),
      timestamp: Number(wire.timestamp),
      ...(wire.feeLimit !== 0n ? { feeLimit: Number(wire.feeLimit) } : {}),
      ...(memo.length > 0 ? { data: toHex(memo) } : {}),
      contract,
    },
    wire,
  };
}

/** `Transaction.parseFrom` (throws `Unparseable`), then the node's reading of the raw data. */
function decodeSigned(hex: unknown): Signed {
  let rawBytes: Uint8Array;
  let signatures: string[];
  let results: Message[];
  try {
    if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
      throw new TypeError('not hex');
    }
    // `Transaction { raw_data = 1; repeated signature = 2; repeated ret = 5 }`; `ret` is
    // echoed, then cleared at admission (`resetResult`) and never counted.
    const tx = readMessage(fromHex(hex), [1, 2, 5]);
    rawBytes = bytesOf(tx, 1);
    const entries = (field: number) =>
      (tx.get(field) ?? []).map((v) => {
        if (!(v instanceof Uint8Array)) throw new TypeError('wrong wire type');
        return v;
      });
    signatures = entries(2).map((s) => toHex(s));
    results = entries(5).map((r) => readMessage(r, null));
  } catch {
    throw new Unparseable();
  }
  try {
    const fields = readMessage(rawBytes, [1, 3, 4, 8, 10, 11, 14, 18]);
    const contracts = (fields.get(11) ?? []).map(readContract);
    const first = contracts[0];
    return {
      rawHex: canonicalRaw(fields, contracts),
      signatures,
      results,
      fields,
      contracts,
      model: first ? model(fields, first) : null,
    };
  } catch {
    return {
      rawHex: toHex(rawBytes),
      signatures,
      results,
      fields: null,
      contracts: [],
      model: null,
    };
  }
}

/**
 * `JsonFormat.printToString(transaction, true)` of the parsed input: every bytes field of
 * these messages is hex, and `ret` is kept (its fee, ret and contractRet; the node prints no
 * other `Result` field).
 */
function echo(signed: Signed): string {
  const f = signed.fields;
  const raw =
    f === null
      ? {}
      : {
          raw_data: {
            ...(bytesOf(f, 1).length > 0
              ? { ref_block_bytes: toHex(bytesOf(f, 1)) }
              : {}),
            ...omitZero('ref_block_num', int64Of(f, 3)),
            ...(bytesOf(f, 4).length > 0 ? { ref_block_hash: toHex(bytesOf(f, 4)) } : {}),
            ...omitZero('expiration', int64Of(f, 8)),
            ...(bytesOf(f, 10).length > 0 ? { data: toHex(bytesOf(f, 10)) } : {}),
            ...(signed.contracts.length > 0
              ? {
                  contract: signed.contracts.map((c) => ({
                    type: CONTRACT_TYPES[c.type.toString()] ?? c.type.toString(),
                    parameter: { type_url: c.typeUrl, value: toHex(c.value) },
                    ...omitZero('Permission_id', c.permissionId),
                  })),
                }
              : {}),
            ...omitZero('timestamp', int64Of(f, 14)),
            ...omitZero('fee_limit', int64Of(f, 18)),
          },
        };
  const name = (names: readonly string[], value: bigint): string =>
    names[Number(value)] ?? value.toString();
  const results = signed.results.map((r) => {
    const code = int64Of(r, 2);
    const contractRet = int64Of(r, 3);
    return {
      ...omitZero('fee', int64Of(r, 1)),
      ...(code !== 0n ? { ret: name(RESULT_CODES, code) } : {}),
      ...(contractRet !== 0n ? { contractRet: name(CONTRACT_RESULTS, contractRet) } : {}),
    };
  });
  return exactJson({
    ...raw,
    ...(signed.signatures.length > 0 ? { signature: signed.signatures } : {}),
    ...(results.length > 0 ? { ret: results } : {}),
  });
}

/** A fee-on-transfer token's collector (mode 'fee'). */
export const FEE_COLLECTOR = '41' + 'fe'.repeat(20);

/** A foreign transaction's result when `place` puts it in a block. */
export type PlacedResult = 'SUCCESS' | 'REVERT';

type Intercept = (
  request: FakeRequest,
  signal: AbortSignal | undefined,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

export class ScriptedTronNode {
  readonly fetch = new FakeFetch();
  readonly params: typeof PARAMS;
  readonly #clock: FakeClock;
  readonly #solidDepth: number;
  readonly #blocks: Block[] = [];
  readonly #pool: StoredTx[] = [];
  /** Foreign transactions `place` queued for the next block. */
  readonly #placed: StoredTx[] = [];
  readonly #foreign = new Map<string, PlacedResult>();
  readonly #lag = new Map<string, number>();
  readonly #timestampLies = new Map<string, number>();
  readonly #intercepts: { endpoint: string; path: string; handler: Intercept }[] = [];
  #salt = 0;
  /** Percent of the base energy a TRC-20 transfer costs (dynamic energy), default 100. */
  energyFactor = 100n;

  constructor(options: NodeOptions) {
    this.#clock = options.clock;
    this.#solidDepth = options.solidDepth ?? 19;
    this.params = { ...PARAMS, ...options.params };
    const genesis = GENESIS[options.network ?? 'nile'] as string;
    this.#blocks.push({
      number: 0,
      id: genesis,
      parentId: '0'.repeat(64),
      timestamp: Math.floor(this.#clock.now() / 3000) * 3000 - 3000,
      txs: [],
      state: { accounts: new Map(), tokens: new Map() },
    });
  }

  // ---- scripting -----------------------------------------------------------------------

  endpoint(name: string): string {
    const url = `https://${name}.tron.test`;
    this.fetch.route(`${url}/`, (request, signal) => this.#serve(name, request, signal));
    return url;
  }

  get head(): number {
    return this.#last.number;
  }

  get solid(): number {
    return Math.max(0, this.head - this.#solidDepth);
  }

  get #last(): Block {
    return this.#blocks[this.#blocks.length - 1] as Block;
  }

  /** A mutable view of the head state for setup (changes apply to later blocks). */
  #account(address: string): Account {
    const hex = toHexAddress(address);
    const accounts = this.#last.state.accounts;
    let account = accounts.get(hex);
    if (!account) {
      account = emptyAccount();
      accounts.set(hex, account);
    }
    return account;
  }

  /** Like a TRX transfer to `address`: it activates the account, so `sun` must be positive. */
  fund(address: string, sun: bigint): void {
    if (sun <= 0n) throw new Error('fund needs a positive amount');
    this.#account(address).balance += sun;
  }

  stake(address: string, resources: { bandwidth?: bigint; energy?: bigint }): void {
    const account = this.#account(address);
    account.stakedNet += resources.bandwidth ?? 0n;
    account.stakedEnergy += resources.energy ?? 0n;
  }

  balance(address: string): bigint {
    return this.#last.state.accounts.get(toHexAddress(address))?.balance ?? 0n;
  }

  exists(address: string): boolean {
    return this.#last.state.accounts.has(toHexAddress(address));
  }

  deployToken(
    address: string,
    token: { symbol: string; decimals: number; mode?: TokenMode },
  ): void {
    this.#last.state.tokens.set(toHexAddress(address), {
      symbol: token.symbol,
      decimals: token.decimals,
      mode: token.mode ?? 'standard',
      balances: new Map(),
    });
  }

  mintToken(token: string, holder: string, amount: bigint): void {
    const state = this.#last.state.tokens.get(toHexAddress(token));
    if (!state) throw new Error('no such token');
    const key = toHexAddress(holder);
    state.balances.set(key, (state.balances.get(key) ?? 0n) + amount);
  }

  tokenBalance(token: string, holder: string): bigint {
    return (
      this.#last.state.tokens
        .get(toHexAddress(token))
        ?.balances.get(toHexAddress(holder)) ?? 0n
    );
  }

  /** Make `endpoint`'s JSON-RPC blocks report timestamps `ms` earlier (a lying endpoint). */
  lieAboutTimestamps(endpoint: string, ms: number): void {
    this.#timestampLies.set(endpoint, ms);
  }

  /** Serve `endpoint`'s views `blocks` blocks behind the head (0 clears it). */
  lag(endpoint: string, blocks: number): void {
    this.#lag.set(endpoint, blocks);
  }

  /**
   * Answer `path` on `endpoint` with `handler` while it returns a reply. The handler gets
   * the request's abort signal and may answer later (a Promise), so timeouts are scriptable.
   */
  intercept(endpoint: string, path: string, handler: Intercept): void {
    this.#intercepts.push({ endpoint, path, handler });
  }

  /**
   * Puts a foreign transaction (a signed Transfer or TriggerSmartContract, with a call value,
   * TRC-10 fields, a permission id or several signatures) into the next mined block. It is
   * never for driver-built transactions: those go through `/wallet/broadcasthex`.
   * - At mining, the node applies java-tron's checks that need no key (exactly one
   *   contract, TaPoS, the size and the expiration against the parent, 1 to 5 signatures,
   *   41… addresses, a positive TRX amount) and drops a transaction that fails them, as a
   *   transaction whose reference block a reorg orphaned.
   * - It verifies no signature and charges no fee. A SUCCESS TRX transfer moves its amount
   *   (the sender must hold it), so the recipient exists; a contract call changes nothing.
   * - Its receipt is `result`, with no fee and no logs.
   * Returns its txID; throws for bytes the node does not model and for a known txID.
   */
  place(hex: string, result: PlacedResult = 'SUCCESS'): string {
    let signed: Signed;
    try {
      signed = decodeSigned(hex);
    } catch {
      throw new Error('place: not a signed transaction');
    }
    if (!signed.model) {
      throw new Error('place: a Transfer or TriggerSmartContract only');
    }
    if (
      result === 'REVERT' &&
      signed.model.raw.contract.type !== 'TriggerSmartContract'
    ) {
      throw new Error('place: only a contract call reverts');
    }
    const tx = this.#stored(signed, signed.model);
    if (this.#known(tx.id)) throw new Error('place: a known transaction');
    this.#foreign.set(tx.id, result);
    this.#placed.push(tx);
    return tx.id;
  }

  inPool(id: string): boolean {
    return this.#pool.some((tx) => tx.id === id);
  }

  transaction(id: string): StoredTx | undefined {
    for (const block of this.#blocks) {
      const tx = block.txs.find((t) => t.id === id);
      if (tx) return tx;
    }
    return undefined;
  }

  block(number: number): { id: string; timestamp: number } | undefined {
    const block = this.#blocks[number];
    return block ? { id: block.id, timestamp: block.timestamp } : undefined;
  }

  /**
   * Mines one block at the next slot (at least one slot after the parent, and not before
   * the clock's slot). Pending transactions that are valid against the parent are
   * executed in arrival order; expired or orphaned ones leave the pool. Placed foreign
   * transactions follow them.
   */
  mine(options: { readonly include?: boolean } = {}): number {
    const parent = this.#last;
    const timestamp = Math.max(
      parent.timestamp + 3000,
      Math.floor(this.#clock.now() / 3000) * 3000,
    );
    let state = cloneState(parent.state);
    const txs: StoredTx[] = [];
    const keep: StoredTx[] = [];
    for (const tx of this.#pool.splice(0)) {
      if (options.include === false) {
        // java-tron drops what can no longer be valid in the next block.
        if (tx.raw.expiration > timestamp) keep.push(tx);
        continue;
      }
      try {
        this.#checkCommon(tx, parent, true);
        const applied = this.#tryApply(state, tx);
        state = applied.state;
        tx.receipt = applied.receipt;
        tx.blockNumber = parent.number + 1;
        txs.push(tx);
      } catch {
        // Invalid in this block (expired, orphaned reference, now unaffordable): dropped.
      }
    }
    this.#pool.push(...keep);
    if (options.include !== false) {
      for (const tx of this.#placed.splice(0)) {
        if (!this.#placeInBlock(tx, parent, state)) continue;
        tx.receipt = {
          contractRet: this.#foreign.get(tx.id) ?? 'SUCCESS',
          fee: 0n,
          netUsage: 0n,
          netFee: 0n,
          energyUsage: 0n,
          energyFee: 0n,
          returned: '',
          logs: [],
        };
        tx.blockNumber = parent.number + 1;
        txs.push(tx);
      }
    }
    const number = parent.number + 1;
    const id = this.#blockId(number, parent.id, timestamp, txs);
    this.#blocks.push({ number, id, parentId: parent.id, timestamp, txs, state });
    return number;
  }

  /**
   * Replaces the last `depth` blocks (never a solidified one) with empty blocks at the same
   * heights and slots but other ids; their transactions go back to the pool (placed ones
   * back to the placed queue).
   */
  reorg(depth: number): void {
    if (depth < 1 || this.head - depth < this.solid) throw new Error('reorg too deep');
    const removed = this.#blocks.splice(this.#blocks.length - depth, depth);
    const returned = removed.flatMap((b) => b.txs);
    for (const tx of returned) {
      delete tx.receipt;
      delete tx.blockNumber;
    }
    this.#pool.unshift(...returned.filter((tx) => !this.#foreign.has(tx.id)));
    this.#placed.unshift(...returned.filter((tx) => this.#foreign.has(tx.id)));
    for (const old of removed) {
      const parent = this.#last;
      this.#salt += 1;
      const id = this.#blockId(old.number, parent.id, old.timestamp, []);
      this.#blocks.push({
        number: old.number,
        id,
        parentId: parent.id,
        timestamp: old.timestamp,
        txs: [],
        state: cloneState(parent.state),
      });
    }
  }

  #blockId(number: number, parentId: string, timestamp: number, txs: StoredTx[]): string {
    const digest = toHex(
      sha256(
        utf8ToBytes(
          `${parentId}:${timestamp}:${this.#salt}:${txs.map((t) => t.id).join(',')}`,
        ),
      ),
    );
    return number.toString(16).padStart(16, '0') + digest.slice(16);
  }

  /**
   * java-tron's checks of a block's transaction that need no key; then a SUCCESS TRX
   * transfer's amount moves (no fee). False drops `tx`.
   */
  #placeInBlock(tx: StoredTx, parent: Block, state: State): boolean {
    const count = tx.signatures.length;
    if (tx.contracts !== 1 || count < 1 || count > TOTAL_SIGN_NUM) return false;
    try {
      this.#checkCommon(tx, parent, true);
    } catch {
      return false;
    }
    const c = tx.raw.contract;
    if (!ADDRESS.test(c.owner)) return false;
    if (c.type === 'TriggerSmartContract') return ADDRESS.test(c.contract);
    if (!ADDRESS.test(c.to) || c.to === c.owner || c.amount <= 0n) return false;
    const owner = state.accounts.get(c.owner);
    if (!owner || owner.balance < c.amount) return false;
    owner.balance -= c.amount;
    const to = state.accounts.get(c.to) ?? emptyAccount();
    to.balance += c.amount;
    state.accounts.set(c.to, to);
    return true;
  }

  #known(id: string): boolean {
    return (
      this.inPool(id) || this.#placed.some((tx) => tx.id === id) || !!this.transaction(id)
    );
  }

  #stored(signed: Signed, read: { raw: TronRawData; wire: WireFields }): StoredTx {
    const size = BigInt(encodeTransaction(signed.rawHex, signed.signatures).length / 2);
    return {
      id: toHex(sha256(fromHex(signed.rawHex))),
      rawHex: signed.rawHex,
      raw: read.raw,
      wire: read.wire,
      contracts: signed.contracts.length,
      signatures: signed.signatures,
      size,
      bytes: size + MAX_RESULT_SIZE,
    };
  }

  // ---- rules ---------------------------------------------------------------------------

  /**
   * `TransactionCapsule.validatePubSignature` and `checkWeight`. The owner permission (id 0)
   * and the default active permission (id 2) each hold the owner's key alone, weight 1,
   * threshold 1.
   */
  #checkSignature(tx: StoredTx): void {
    const count = tx.signatures.length;
    if (count === 0) throw badSignature('miss sig or contract');
    if (count > TOTAL_SIGN_NUM) throw badSignature('too many signatures');
    if (tx.wire.permissionId !== 0n && tx.wire.permissionId !== 2n) {
      throw badSignature("permission isn't exit");
    }
    if (count > 1) {
      throw badSignature(
        `Signature count is ${count} more than key counts of permission : 1`,
      );
    }
    const signer = this.#signer(tx.signatures[0] as string, tx.id);
    // Not verified: the text for a signature no key can be recovered from.
    if (signer === null) throw badSignature('sig error');
    if (toHexAddress(signer) !== tx.raw.contract.owner) {
      throw badSignature(
        `${tx.id} is signed by ${signer} but it is not contained of permission.`,
      );
    }
  }

  /**
   * `Manager.validateTapos` and `validateCommon` against `parent`. With
   * `getConsensusLogicOptimization` = 1 (mainnet), the size with results is checked in
   * blocks too, and a block refuses an expiration before the next slot
   * (`TransactionCapsule.checkExpiration`).
   */
  #checkCommon(tx: StoredTx, parent: Block, inBlock: boolean): void {
    const refNumber = this.#blocks
      .slice(0, parent.number + 1)
      .filter(
        (b) =>
          b.number.toString(16).padStart(16, '0').slice(12, 16) === tx.raw.refBlockBytes,
      );
    if (!refNumber.some((b) => b.id.slice(16, 32) === tx.raw.refBlockHash)) {
      throw new Refusal('TAPOS_ERROR', 'Tapos check error.');
    }
    // The size without `ret` plus two result allowances. java-tron's second check (the
    // serialized size alone) can never fail after this one, so it is not modelled.
    const withResult = tx.size + 2n * MAX_RESULT_SIZE;
    if (withResult > MAX_TX_BYTES) {
      throw new Refusal(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction with result, TxId ${tx.id}, the size is ${withResult} bytes, maxTxSize ${MAX_TX_BYTES}`,
      );
    }
    const expiration = tx.wire.expiration;
    const at = BigInt(parent.timestamp);
    if (inBlock && expiration < at + BigInt(SLOT_MS)) throw expired();
    if (expiration <= at || expiration > at + BigInt(MAX_EXPIRATION_MS)) throw expired();
  }

  #bandwidth(
    owner: Account,
    tx: StoredTx,
    creates: boolean,
  ): {
    fee: bigint;
    usage: bigint;
  } {
    const bytes = tx.bytes;
    if (creates) {
      const cost = bytes * this.params.getCreateNewAccountBandwidthRate;
      if (owner.stakedNet - owner.netUsed >= cost) {
        owner.netUsed += cost;
        return { fee: 0n, usage: cost };
      }
      if (owner.balance < this.params.getCreateAccountFee) throw insufficient();
      owner.balance -= this.params.getCreateAccountFee;
      return { fee: this.params.getCreateAccountFee, usage: 0n };
    }
    if (owner.stakedNet - owner.netUsed >= bytes) {
      owner.netUsed += bytes;
      return { fee: 0n, usage: bytes };
    }
    if (this.params.getFreeNetLimit - owner.freeNetUsed >= bytes) {
      owner.freeNetUsed += bytes;
      return { fee: 0n, usage: bytes };
    }
    const fee = bytes * this.params.getTransactionFee;
    if (owner.balance < fee) throw insufficient();
    owner.balance -= fee;
    return { fee, usage: 0n };
  }

  /**
   * `#apply` on a copy of `state`: the new state and the receipt, or a `Refusal` with
   * `state` untouched. java-tron runs each transaction in its own revoking session, so a
   * refused one leaves nothing behind (not even the bandwidth it had counted).
   */
  #tryApply(
    state: State,
    tx: StoredTx,
  ): { readonly state: State; readonly receipt: Receipt } {
    const next = cloneState(state);
    return { state: next, receipt: this.#apply(next, tx) };
  }

  /**
   * `Manager.processTransaction` from bandwidth on, on `state` (mutating it): bandwidth
   * (`BandwidthProcessor.consume`), the memo fee (`consumeMemoFee`), then the contract.
   * Throws a `Refusal` when invalid.
   */
  #apply(state: State, tx: StoredTx): Receipt {
    const { contract } = tx.raw;
    const owner = state.accounts.get(contract.owner);
    if (!owner) {
      throw invalid(`account [${toBase58Address(contract.owner)}] does not exist`);
    }
    const creates =
      contract.type === 'TransferContract' &&
      !state.accounts.has(contract.to) &&
      !state.tokens.has(contract.to);
    if (creates) {
      const size = tx.size - BigInt(tx.signatures.length * SIGNATURE_BYTES);
      if (size > this.params.getMaxCreateAccountTxSize) {
        throw new Refusal(
          'TOO_BIG_TRANSACTION_ERROR',
          `Too big new account transaction, TxId ${tx.id}, the size is ${size} bytes, maxTxSize ${this.params.getMaxCreateAccountTxSize}`,
        );
      }
    }
    const net = this.#bandwidth(owner, tx, creates);
    const memoFee = tx.raw.data !== undefined ? this.params.getMemoFee : 0n;
    if (owner.balance < memoFee) throw insufficient();
    owner.balance -= memoFee;
    const paid = { fee: net.fee + memoFee, netUsage: net.usage, netFee: net.fee };
    if (contract.type === 'TransferContract') {
      // TransferActuator.validate, then execute.
      if (!ADDRESS.test(contract.owner)) throw invalid('Invalid ownerAddress!');
      if (!ADDRESS.test(contract.to)) throw invalid('Invalid toAddress!');
      if (contract.to === contract.owner) {
        throw invalid('Cannot transfer TRX to yourself.');
      }
      if (contract.amount <= 0n) throw invalid('Amount must be greater than 0.');
      if (
        this.params.getForbidTransferToContract === 1n &&
        state.tokens.has(contract.to)
      ) {
        throw invalid('Cannot transfer TRX to a smartContract.');
      }
      const systemFee = creates ? this.params.getCreateNewAccountFeeInSystemContract : 0n;
      if (owner.balance < contract.amount + systemFee) {
        throw invalid('Validate TransferContract error, balance is not sufficient.');
      }
      owner.balance -= contract.amount + systemFee;
      const to = state.accounts.get(contract.to) ?? emptyAccount();
      to.balance += contract.amount;
      state.accounts.set(contract.to, to);
      return {
        ...paid,
        contractRet: 'SUCCESS',
        fee: paid.fee + systemFee,
        energyUsage: 0n,
        energyFee: 0n,
        returned: '',
        logs: [],
      };
    }
    // VMActuator.call: the contract, the call value, the fee limit, the energy limit, then
    // the call value's transfer (MUtil.transfer) and the TRC-10 one (MUtil.transferToken),
    // all before execution.
    const token = state.tokens.get(contract.contract);
    if (!token) throw invalid('No contract or not a smart contract');
    const callValue = tx.wire.callValue;
    const { callTokenValue, tokenId } = tx.wire;
    if (callValue < 0n) throw invalid('callValue must be >= 0');
    if (callTokenValue < 0n) throw invalid('tokenValue must be >= 0');
    // checkTokenValueAndId (VMConstant.MIN_TOKEN_ID = 1,000,000).
    if (tokenId <= 1_000_000n && tokenId !== 0n) {
      throw invalid('tokenId must be > 1000000');
    }
    if (callTokenValue > 0n && tokenId === 0n) {
      throw invalid(
        `invalid arguments with tokenValue = ${callTokenValue}, tokenId = ${tokenId}`,
      );
    }
    const feeLimit = tx.wire.feeLimit;
    if (feeLimit < 0n || feeLimit > this.params.getMaxFeeLimit) {
      throw invalid(`feeLimit must be >= 0 and <= ${this.params.getMaxFeeLimit}`);
    }
    const price = this.params.getEnergyFee;
    const spendable = owner.balance > callValue ? owner.balance - callValue : 0n;
    const staked = owner.stakedEnergy - owner.energyUsed;
    const limit = min(staked + spendable / price, feeLimit / price);
    if (owner.balance < callValue) {
      throw invalid('Validate InternalTransfer error, balance is not sufficient.');
    }
    // VMUtils.validateForSmartContract (TRC-10): the node issues no TRC-10 asset.
    if (callTokenValue > 0n) throw invalid('No asset !');
    // The node's tokens are not payable, so a call with a value reverts and returns it.
    const call = this.#tokenCall(
      contract.contract,
      token,
      contract.owner,
      contract.data,
      callValue,
    );
    const needed = call.energy;
    const used = needed <= limit ? needed : limit;
    const fromStake = min(used, staked);
    const burned = (used - fromStake) * price;
    owner.energyUsed += fromStake;
    owner.balance -= burned;
    const spent = {
      ...paid,
      fee: paid.fee + burned,
      energyUsage: fromStake,
      energyFee: burned,
    };
    if (needed > limit) {
      return { ...spent, contractRet: 'OUT_OF_ENERGY', returned: '', logs: [] };
    }
    if (call.revert) return { ...spent, contractRet: 'REVERT', returned: '', logs: [] };
    call.commit?.();
    return { ...spent, contractRet: 'SUCCESS', returned: call.result, logs: call.logs };
  }

  /** A TRC-20 call on `token` from `caller`: its result, energy, logs and state change. */
  #tokenCall(
    address: string,
    token: Token,
    caller: string,
    data: string,
    callValue = 0n,
  ): {
    readonly result: string;
    readonly energy: bigint;
    readonly revert: boolean;
    readonly logs: { address: string; topics: string[]; data: string }[];
    readonly commit?: () => void;
  } {
    if (callValue > 0n) {
      return { result: '', energy: NON_PAYABLE_ENERGY, revert: true, logs: [] };
    }
    const selector = data.slice(0, 8);
    const arg = (i: number) => data.slice(8 + i * 64, 8 + (i + 1) * 64);
    const holder = (w: string) => `41${w.slice(24)}`;
    if (selector === '70a08231' && data.length === 72) {
      return {
        result: word(token.balances.get(holder(arg(0))) ?? 0n),
        energy: 4_000n,
        revert: false,
        logs: [],
      };
    }
    if (selector === '313ce567' && data.length === 8) {
      if (token.mode === 'reverting-metadata')
        return { result: '', energy: 300n, revert: true, logs: [] };
      return {
        result: word(BigInt(token.decimals)),
        energy: 300n,
        revert: false,
        logs: [],
      };
    }
    if (selector === '95d89b41' && data.length === 8) {
      if (token.mode === 'reverting-metadata')
        return { result: '', energy: 300n, revert: true, logs: [] };
      const bytes = hexOf(token.symbol);
      return {
        result: word(32n) + word(BigInt(bytes.length / 2)) + bytes.padEnd(64, '0'),
        energy: 600n,
        revert: false,
        logs: [],
      };
    }
    if (selector === 'a9059cbb' && data.length === 136) {
      const to = holder(arg(0));
      const amount = BigInt(`0x${arg(1)}`);
      const balance = token.balances.get(caller) ?? 0n;
      const fresh = (token.balances.get(to) ?? 0n) === 0n;
      const energy =
        ((TRANSFER_ENERGY + (fresh ? NEW_HOLDER_ENERGY : 0n)) * this.energyFactor) / 100n;
      if (balance < amount) return { result: '', energy: 1_000n, revert: true, logs: [] };
      const topic = toHex(keccak_256(utf8ToBytes('Transfer(address,address,uint256)')));
      const log = (to_: string, value: bigint) => ({
        address: address.slice(2),
        topics: [
          topic,
          caller.slice(2).padStart(64, '0'),
          to_.slice(2).padStart(64, '0'),
        ],
        data: word(value),
      });
      if (token.mode === 'fee' && amount > 1n) {
        // A fee of 1 base unit: the recipient gets amount - 1, the collector 1.
        return {
          result: word(1n),
          energy,
          revert: false,
          logs: [log(to, amount - 1n), log(FEE_COLLECTOR, 1n)],
          commit: () => {
            token.balances.set(caller, balance - amount);
            token.balances.set(to, (token.balances.get(to) ?? 0n) + amount - 1n);
            token.balances.set(
              FEE_COLLECTOR,
              (token.balances.get(FEE_COLLECTOR) ?? 0n) + 1n,
            );
          },
        };
      }
      return {
        result: word(token.mode === 'no-log' ? 0n : 1n),
        energy,
        revert: false,
        logs:
          token.mode === 'no-log'
            ? []
            : [
                {
                  address: address.slice(2),
                  topics: [
                    toHex(keccak_256(utf8ToBytes('Transfer(address,address,uint256)'))),
                    caller.slice(2).padStart(64, '0'),
                    to.slice(2).padStart(64, '0'),
                  ],
                  data: word(amount),
                },
              ],
        commit: () => {
          if (token.mode === 'no-log') return;
          token.balances.set(caller, balance - amount);
          token.balances.set(to, (token.balances.get(to) ?? 0n) + amount);
        },
      };
    }
    return { result: '', energy: 500n, revert: true, logs: [] };
  }

  /** The base58 signer recovered from a 65-byte signature over `id`, or null. */
  #signer(signature: string, id: string): string | null {
    const sig = fromHex(signature);
    const v = sig[64] as number;
    const recovery = v >= 27 ? v - 27 : v;
    try {
      const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
        .addRecoveryBit(recovery)
        .recoverPublicKey(fromHex(id));
      return addressFromPublicKey(point.toRawBytes(true));
    } catch {
      return null;
    }
  }

  /**
   * `BroadcastHexServlet`: `{ result, code, message, transaction, txid }` for every parsed
   * transaction (the message is plain text, `transaction` the parsed input as
   * `JsonFormat.printToString(transaction, true)`), or `Util.printErrorMsg`'s `{ Error }`
   * when the bytes do not parse.
   */
  #broadcast(input: unknown): Record<string, unknown> {
    let signed: Signed;
    try {
      signed = decodeSigned(input);
    } catch (error) {
      if (!(error instanceof Unparseable)) throw error;
      return {
        Error:
          'class com.google.protobuf.InvalidProtocolBufferException : the node cannot parse these bytes',
      };
    }
    const envelope = {
      transaction: echo(signed),
      txid: toHex(sha256(fromHex(signed.rawHex))),
    };
    try {
      this.#pool.push(this.#admit(signed));
      return { result: true, code: 'SUCCESS', message: '', ...envelope };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { result: false, code: error.code, message: error.message, ...envelope };
    }
  }

  /** The admission order of `Wallet.broadcastTransaction` and `Manager.pushTransaction`. */
  #admit(signed: Signed): StoredTx {
    for (const s of signed.signatures) {
      const size = s.length / 2;
      // java-tron lets 66–68 bytes through to recovery; the node refuses every size but 65.
      if (size !== SIGNATURE_BYTES) throw badSignature(`Signature size is ${size}`);
    }
    // No contract at all (verified), or a contract the node does not model (the brief's
    // answer; java-tron would validate it as its type).
    if (signed.contracts.length === 0 || !signed.model) throw invalid('No contract!');
    const tx = this.#stored(signed, signed.model);
    const head = this.#last;
    if (tx.wire.expiration < BigInt(head.timestamp + SLOT_MS)) throw expired();
    this.#checkSignature(tx);
    if (signed.contracts.length !== 1) {
      throw invalid(
        `tx ${tx.id} contract size should be exactly 1, this is extend feature ,actual :${signed.contracts.length}`,
      );
    }
    this.#checkCommon(tx, head, false);
    if (this.#known(tx.id))
      throw new Refusal('DUP_TRANSACTION_ERROR', 'Dup transaction.');
    let pending = head.state;
    for (const earlier of this.#pool) {
      try {
        pending = this.#tryApply(pending, earlier).state;
      } catch {
        // Pool entries that no longer apply are dropped at mining.
      }
    }
    this.#tryApply(pending, tx);
    return tx;
  }

  // ---- HTTP ----------------------------------------------------------------------------

  #view(endpoint: string): { head: number; solid: number } {
    const head = Math.max(0, this.head - (this.#lag.get(endpoint) ?? 0));
    return { head, solid: Math.max(0, head - this.#solidDepth) };
  }

  /**
   * proto3 JSON (`JsonFormat`) drops default values. java-tron builds block 0 from config
   * (`BlockUtil.newGenesisBlockCapsule`; mainnet `timestamp = "0"`, config.conf:399) with
   * number 0, no version and no witness signature, so its header serves none of the four.
   * The node keeps block 0's own slot time for its rules (TaPoS, expiration).
   */
  #header(block: Block): Record<string, unknown> {
    const genesis = block.number === 0;
    return {
      blockID: block.id,
      block_header: {
        raw_data: {
          ...(genesis ? {} : { number: block.number }),
          txTrieRoot:
            block.txs.length === 0
              ? '0'.repeat(64)
              : toHex(sha256(utf8ToBytes(block.id))),
          witness_address: '41' + 'ab'.repeat(20),
          parentHash: block.parentId,
          ...(genesis ? {} : { version: 32, timestamp: block.timestamp }),
        },
        ...(genesis ? {} : { witness_signature: 'ff'.repeat(65) }),
      },
    };
  }

  #txJson(tx: StoredTx): Record<string, unknown> {
    const c = tx.raw.contract;
    const w = tx.wire;
    return {
      ...(tx.receipt ? { ret: [{ contractRet: tx.receipt.contractRet }] } : {}),
      signature: tx.signatures,
      txID: tx.id,
      raw_data: {
        contract: [
          {
            ...(c.type === 'TransferContract'
              ? {
                  parameter: {
                    value: {
                      amount: c.amount,
                      owner_address: c.owner,
                      to_address: c.to,
                    },
                    type_url: 'type.googleapis.com/protocol.TransferContract',
                  },
                  type: 'TransferContract',
                }
              : {
                  parameter: {
                    value: {
                      data: c.data,
                      owner_address: c.owner,
                      contract_address: c.contract,
                      ...omitZero('call_value', w.callValue),
                      ...omitZero('call_token_value', w.callTokenValue),
                      ...omitZero('token_id', w.tokenId),
                    },
                    type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
                  },
                  type: 'TriggerSmartContract',
                }),
            ...omitZero('Permission_id', w.permissionId),
          },
        ],
        ref_block_bytes: tx.raw.refBlockBytes,
        ...omitZero('ref_block_num', w.refBlockNum),
        ref_block_hash: tx.raw.refBlockHash,
        expiration: w.expiration,
        ...(tx.raw.data !== undefined ? { data: tx.raw.data } : {}),
        ...omitZero('fee_limit', w.feeLimit),
        // The exact int64 of the bytes, even above 2^53.
        ...omitZero('timestamp', w.timestamp),
      },
      raw_data_hex: tx.rawHex,
    };
  }

  #infoJson(tx: StoredTx): Record<string, unknown> {
    const r = tx.receipt as Receipt;
    const block = this.#blocks[tx.blockNumber as number] as Block;
    const trigger = tx.raw.contract.type === 'TriggerSmartContract';
    return {
      id: tx.id,
      ...omitZero('fee', r.fee),
      blockNumber: block.number,
      blockTimeStamp: block.timestamp,
      contractResult: [r.returned],
      ...(trigger
        ? { contract_address: (tx.raw.contract as { contract: string }).contract }
        : {}),
      receipt: {
        ...omitZero('energy_usage', r.energyUsage),
        ...omitZero('energy_fee', r.energyFee),
        ...omitZero(
          'energy_usage_total',
          r.energyUsage + r.energyFee / this.params.getEnergyFee,
        ),
        ...omitZero('net_usage', r.netUsage),
        ...omitZero('net_fee', r.netFee),
        ...(trigger ? { result: r.contractRet } : {}),
      },
      ...(r.logs.length > 0 ? { log: r.logs } : {}),
      ...(r.contractRet !== 'SUCCESS'
        ? {
            result: 'FAILED',
            resMessage: hexOf(
              r.contractRet === 'REVERT' ? 'REVERT opcode executed' : 'Not enough energy',
            ),
          }
        : {}),
    };
  }

  #findBlock(idOrNum: unknown, limit: number): Block | undefined {
    if (typeof idOrNum === 'string' && /^[0-9a-f]{64}$/.test(idOrNum)) {
      const block = this.#blocks.find((b) => b.id === idOrNum);
      return block && block.number <= limit ? block : undefined;
    }
    const n = typeof idOrNum === 'number' ? idOrNum : Number(idOrNum);
    return Number.isSafeInteger(n) && n >= 0 && n <= limit ? this.#blocks[n] : undefined;
  }

  /** Every JSON answer is written with exact integers, as java-tron does (A12). */
  async #serve(
    endpoint: string,
    request: FakeRequest,
    signal: AbortSignal | undefined,
  ): Promise<FakeReply> {
    const reply = await this.#answer(endpoint, request, signal);
    if (reply instanceof Response || !('json' in reply) || reply.json === undefined) {
      return reply;
    }
    const { json, ...rest } = reply;
    return {
      ...rest,
      text: exactJson(json),
      headers: { 'content-type': 'application/json', ...rest.headers },
    };
  }

  async #answer(
    endpoint: string,
    request: FakeRequest,
    signal: AbortSignal | undefined,
  ): Promise<FakeReply> {
    const path = request.url.pathname;
    for (const i of this.#intercepts) {
      if (i.endpoint === endpoint && i.path === path) {
        const reply = await i.handler(request, signal);
        if (reply) return reply;
      }
    }
    const view = this.#view(endpoint);
    const body =
      request.method === 'POST' ? (request.json<Record<string, unknown>>() ?? {}) : {};
    const solidity = path.startsWith('/walletsolidity/');
    const limit = solidity ? view.solid : view.head;
    // The solidity node serves solidified state, and it takes no transactions.
    const state = (this.#blocks[limit] as Block).state;
    const visible = (tx: StoredTx | undefined) =>
      tx && tx.blockNumber !== undefined && tx.blockNumber <= limit ? tx : undefined;
    const name = path.replace(/^\/wallet(solidity)?\//, '');
    if (path === '/jsonrpc') return this.#jsonRpc(request, view.head, endpoint);
    if (path.startsWith('/v1/accounts/')) return this.#history(request, view);
    if (solidity && (name === 'broadcasthex' || name === 'gettransactionfrompending')) {
      return { status: 404, text: 'Not Found' };
    }
    switch (name) {
      case 'getblock': {
        const block =
          body.id_or_num === undefined
            ? this.#blocks[limit]
            : this.#findBlock(body.id_or_num, limit);
        if (!block) return { json: {} };
        return {
          json: {
            ...this.#header(block),
            ...(body.detail === true && block.txs.length > 0
              ? { transactions: block.txs.map((t) => this.#txJson(t)) }
              : {}),
          },
        };
      }
      case 'getblockbynum': {
        const block = this.#findBlock(body.num, limit);
        return { json: block ? this.#header(block) : {} };
      }
      case 'getchainparameters':
        return {
          json: {
            chainParameter: [
              ...Object.entries(this.params).map(([key, value]) => ({
                key,
                ...(value === 0n ? {} : { value: Number(value) }),
              })),
              // As on Nile: a parameter with a negative value the driver never reads.
              { key: 'getRemoveThePowerOfTheGr', value: -1 },
            ],
          },
        };
      case 'getaccount': {
        const account = state.accounts.get(String(body.address));
        if (!account) return { json: {} };
        return {
          json: {
            address: body.address,
            ...omitZero('balance', account.balance),
            create_time: 1,
          },
        };
      }
      case 'getaccountresource': {
        const account = state.accounts.get(String(body.address));
        if (!account) return { json: {} };
        return {
          json: {
            freeNetLimit: Number(this.params.getFreeNetLimit),
            ...omitZero('freeNetUsed', account.freeNetUsed),
            ...omitZero('NetLimit', account.stakedNet),
            ...omitZero('NetUsed', account.netUsed),
            ...omitZero('EnergyLimit', account.stakedEnergy),
            ...omitZero('EnergyUsed', account.energyUsed),
            TotalNetLimit: 43_200_000_000,
            TotalEnergyLimit: 180_000_000_000,
          },
        };
      }
      case 'triggerconstantcontract': {
        const token = state.tokens.get(String(body.contract_address));
        if (!token) {
          return {
            json: {
              result: {
                code: 'CONTRACT_VALIDATE_ERROR',
                message: hexOf('Smart contract is not exist.'),
              },
            },
          };
        }
        const call = this.#tokenCall(
          String(body.contract_address),
          token,
          String(body.owner_address),
          String(body.data ?? ''),
          typeof body.call_value === 'number' ? BigInt(body.call_value) : 0n,
        );
        // java-tron builds the simulated transaction on its own head: its reference block,
        // expiration and txID differ between honest endpoints at different heights.
        const head = this.#blocks[limit] as Block;
        return {
          json: {
            constant_result: [call.result],
            result: {
              result: true,
              ...(call.revert ? { message: hexOf('REVERT opcode executed') } : {}),
            },
            energy_used: Number(call.energy),
            transaction: {
              ret: [call.revert ? { ret: 'FAILED' } : {}],
              txID: toHex(sha256(utf8ToBytes(`${head.id}:${String(body.data ?? '')}`))),
              raw_data: {
                ref_block_bytes: head.id.slice(12, 16),
                ref_block_hash: head.id.slice(16, 32),
                expiration: head.timestamp + 60_000,
                timestamp: head.timestamp,
              },
            },
          },
        };
      }
      case 'broadcasthex':
        return { json: this.#broadcast(body.transaction) };
      case 'gettransactionbyid': {
        const tx = visible(this.transaction(String(body.value)));
        return { json: tx ? this.#txJson(tx) : {} };
      }
      case 'gettransactioninfobyid': {
        const tx = visible(this.transaction(String(body.value)));
        return { json: tx ? this.#infoJson(tx) : {} };
      }
      case 'gettransactionfrompending': {
        const tx = this.#pool.find((t) => t.id === body.value);
        return { json: tx && view.head === this.head ? this.#txJson(tx) : {} };
      }
      case 'gettransactioninfobyblocknum': {
        const block = this.#findBlock(body.num, limit);
        return { json: block ? block.txs.map((t) => this.#infoJson(t)) : [] };
      }
      default:
        return { status: 404, text: 'Not Found' };
    }
  }

  #jsonRpc(request: FakeRequest, head: number, endpoint: string): FakeReply {
    const skew = this.#timestampLies.get(endpoint) ?? 0;
    const { id, method, params } = request.json<{
      id: unknown;
      method: string;
      params: unknown[];
    }>();
    const reply = (result: unknown) => ({ json: { jsonrpc: '2.0', id, result } });
    const shape = (block: Block | undefined) =>
      block
        ? {
            number: `0x${block.number.toString(16)}`,
            hash: `0x${block.id}`,
            parentHash: `0x${block.parentId}`,
            // BlockResult: toJsonHex(time / 1000); block 0's time is 0 (see #header).
            timestamp:
              block.number === 0
                ? '0x0'
                : `0x${Math.floor((block.timestamp - skew) / 1000).toString(16)}`,
            transactions: block.txs.map((t) => `0x${t.id}`),
          }
        : null;
    if (method === 'eth_getBlockByHash') {
      const hash = String(params[0]).replace(/^0x/, '');
      return reply(shape(this.#findBlock(hash, head)));
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = String(params[0]);
      const n =
        tag === 'latest'
          ? head
          : tag === 'finalized'
            ? Math.max(0, head - this.#solidDepth)
            : Number(BigInt(tag));
      return reply(shape(this.#findBlock(n, head)));
    }
    return {
      json: { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } },
    };
  }

  /**
   * TronGrid `/v1/accounts/:address/transactions[/trc20]`: entries in blocks up to the
   * head (reorgable), or solidified only with `only_confirmed=true`; at most 200 a page.
   */
  #history(request: FakeRequest, view: { head: number; solid: number }): FakeReply {
    const [, , , address, , kind] = request.url.pathname.split('/');
    const hex = toHexAddress(String(address));
    const query = request.url.searchParams;
    const upTo = query.get('only_confirmed') === 'true' ? view.solid : view.head;
    const limit = Math.min(Number(query.get('limit') ?? '20'), HISTORY_MAX_LIMIT);
    const start = Number(query.get('fingerprint') ?? '0');
    const txs = this.#blocks
      .slice(1, upTo + 1)
      .reverse()
      .flatMap((b) => [...b.txs].reverse());
    const trc20 = kind === 'trc20';
    const related = txs.filter((t) => {
      const c = t.raw.contract;
      if (!trc20)
        return c.owner === hex || (c.type === 'TransferContract' && c.to === hex);
      return (t.receipt?.logs ?? []).some(
        (l) => l.topics[1]?.endsWith(hex.slice(2)) || l.topics[2]?.endsWith(hex.slice(2)),
      );
    });
    const page = related.slice(start, start + limit);
    const next = start + limit < related.length ? String(start + limit) : undefined;
    const data = page.map((t) => {
      const block = this.#blocks[t.blockNumber as number] as Block;
      if (!trc20)
        return {
          ...this.#txJson(t),
          blockNumber: block.number,
          block_timestamp: block.timestamp,
        };
      return { transaction_id: t.id, block_timestamp: block.timestamp, type: 'Transfer' };
    });
    return {
      json: {
        data,
        success: true,
        meta: {
          at: this.#clock.now(),
          page_size: data.length,
          ...(next ? { fingerprint: next } : {}),
        },
      },
    };
  }
}
