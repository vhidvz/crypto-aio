/**
 * The tronweb strategy: protobuf work through tronweb's own
 * `txJsonToPb`/`txPbToRawDataHex`/`deserializeTransaction`, and the `crypto-aio/native`
 * client. No I/O here: driver requests go straight to the transport, so no
 * tronweb code sits on a request path. Decoding is strict: the decoded fields
 * must re-encode to exactly the input bytes, so bytes with fields this model does not carry
 * (a permission id, `ref_block_num`, a call value) are refused. Reading chain history
 * (`readRaw`) is lenient, and reports a call's value rather than dropping it.
 */
import { TronWeb, providers, utils } from 'tronweb';
import { ValidationError } from '../../core/errors/error';
import { fromHex } from '../../core/util/bytes';
import type { HttpRequest, Transport } from '../../core/transport/types';
import { PLACEHOLDER_ORIGIN } from '../../core/transport/types';
import { tronDriverFactory } from './driver';
import { bytesOf, singular, wireFields } from './protobuf';
import type { TronCodec, TronContract, TronRawData } from './types';

const TYPE_URL = 'type.googleapis.com/protocol.';
const HEX = /^(?:[0-9a-f]{2})*$/;
const ADDRESS = /^41[0-9a-f]{40}$/;
const INT64_MAX = (1n << 63n) - 1n;
/**
 * java-tron refuses a transaction above `TRANSACTION_MAX_BYTE_SIZE` (500 × 1024
 * bytes, `Constant.java`, checked in `Manager`), and `raw_data` is part of it, so longer
 * hex is refused before any decoding.
 */
const MAX_RAW_HEX = 2 * 500 * 1024;

function refuse(reason: string): never {
  throw new ValidationError(
    'INVALID_INTENT',
    `cannot encode a Tron transaction: ${reason}`,
  );
}

/**
 * tronweb writes these `int64` fields from JS numbers, so each must be a safe
 * non-negative integer (a larger one would round). Anything else is refused with a fixed
 * text that never contains the value: `INVALID_AMOUNT` for the TRX amount, `INVALID_INTENT`
 * for the other fields.
 */
function safe(
  value: bigint | number,
  field: 'amount' | 'expiration' | 'timestamp' | 'fee_limit',
): number {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    (typeof value === 'bigint' && BigInt(n) !== value)
  ) {
    if (field !== 'amount') refuse(`${field} must be a safe non-negative integer`);
    throw new ValidationError(
      'INVALID_AMOUNT',
      'amount must be a safe non-negative integer',
    );
  }
  return n;
}

function contractJson(contract: TronContract): Record<string, unknown> {
  if (!ADDRESS.test(contract.owner)) refuse('bad owner address');
  if (contract.type === 'TransferContract') {
    if (!ADDRESS.test(contract.to)) refuse('bad recipient address');
    return {
      type: 'TransferContract',
      parameter: {
        type_url: `${TYPE_URL}TransferContract`,
        value: {
          owner_address: contract.owner,
          to_address: contract.to,
          amount: safe(contract.amount, 'amount'),
        },
      },
    };
  }
  if (!ADDRESS.test(contract.contract)) refuse('bad contract address');
  if (!HEX.test(contract.data) || contract.data.length === 0) refuse('bad call data');
  // What `readRaw` reports of a chain call is never written: the driver's calls carry no value.
  if (
    contract.callValue !== undefined ||
    contract.callTokenValue !== undefined ||
    contract.tokenId !== undefined
  ) {
    refuse('a contract call with a value');
  }
  return {
    type: 'TriggerSmartContract',
    parameter: {
      type_url: `${TYPE_URL}TriggerSmartContract`,
      value: {
        owner_address: contract.owner,
        contract_address: contract.contract,
        data: contract.data,
      },
    },
  };
}

function encodeRaw(raw: TronRawData): string {
  if (!/^[0-9a-f]{4}$/.test(raw.refBlockBytes)) refuse('bad ref_block_bytes');
  if (!/^[0-9a-f]{16}$/.test(raw.refBlockHash)) refuse('bad ref_block_hash');
  if (raw.data !== undefined && (!HEX.test(raw.data) || raw.data.length === 0)) {
    refuse('bad memo bytes');
  }
  const json = {
    raw_data: {
      ref_block_bytes: raw.refBlockBytes,
      ref_block_hash: raw.refBlockHash,
      expiration: safe(raw.expiration, 'expiration'),
      timestamp: safe(raw.timestamp, 'timestamp'),
      ...(raw.feeLimit !== undefined
        ? { fee_limit: safe(raw.feeLimit, 'fee_limit') }
        : {}),
      ...(raw.data !== undefined ? { data: raw.data } : {}),
      contract: [contractJson(raw.contract)],
    },
  };
  return utils.transaction
    .txPbToRawDataHex(utils.transaction.txJsonToPb(json))
    .toLowerCase();
}

/**
 * The `Contract` of `Transaction.raw` bytes when there is exactly one (raw field 11; java-tron
 * requires one), else `null`. Other repeated raw fields, such as the unused `auths`, are
 * client metadata and stay readable.
 */
function onlyContract(raw: Uint8Array): Uint8Array | null {
  const contracts = wireFields(raw, 'opaque')?.filter((f) => f.field === 11) ?? [];
  return contracts.length === 1 ? bytesOf(contracts[0]?.value) : null;
}

/**
 * SDK-free and exact: the amount of the single TransferContract in `Transaction.raw` bytes
 * (raw field 11 → `Contract` field 2 → `Any` field 2 → TransferContract field 3), or null.
 * The amount is an `int64`, so a varint at or above 2^63 (a negative amount) is null too.
 */
export function transferAmount(rawHex: string): bigint | null {
  if (typeof rawHex !== 'string' || rawHex.length > MAX_RAW_HEX) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromHex(rawHex);
  } catch {
    return null;
  }
  const entry = singular(onlyContract(bytes));
  if (entry?.get(1) !== 1n) return null; // ContractType.TransferContract
  const any = singular(bytesOf(entry.get(2)));
  const amount = singular(bytesOf(any?.get(2)))?.get(3);
  return typeof amount === 'bigint' && amount <= INT64_MAX ? amount : null;
}

type CallValues = Pick<
  Extract<TronContract, { type: 'TriggerSmartContract' }>,
  'callValue' | 'callTokenValue' | 'tokenId'
>;

/**
 * SDK-free and exact (tronweb reads these `int64`s as rounded numbers): the TRX and
 * TRC-10 value of the single TriggerSmartContract in `Transaction.raw` bytes (fields 3, 5
 * and 6), each only when non-zero; `null` when unreadable or negative (VMActuator refuses a
 * negative value, so no block holds one).
 */
function callValues(bytes: Uint8Array): CallValues | null {
  const entry = singular(onlyContract(bytes));
  if (entry?.get(1) !== 31n) return null; // ContractType.TriggerSmartContract
  const call = singular(bytesOf(singular(bytesOf(entry.get(2)))?.get(2)));
  if (!call) return null;
  const values: Record<string, bigint> = {};
  for (const [field, name] of [
    [3, 'callValue'],
    [5, 'callTokenValue'],
    [6, 'tokenId'],
  ] as const) {
    const value = call.get(field) ?? 0n;
    if (typeof value !== 'bigint' || value > INT64_MAX) return null;
    if (value !== 0n) values[name] = value;
  }
  return values;
}

type Decoded = {
  contract?: { type?: string; parameter?: { value?: Record<string, unknown> } }[];
  data?: string;
  fee_limit?: number;
  ref_block_bytes?: string;
  ref_block_hash?: string;
  expiration?: number;
  timestamp?: number;
};

function malformed(): never {
  throw new ValidationError('INVALID_INTENT', 'not a Tron transfer or contract call');
}

function hexField(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : malformed();
}

/** An `int64` tronweb read as a JS number is exact only when safe; a count is not negative. */
function exact(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Lenient on what the chain accepts: `readRaw` reads chain history, so client-set
 * fields java-tron leaves unbounded never make a transaction unreadable. Refusing real
 * chain data would stall history and scans: a mainnet transfer in block 86,615,431
 * carries a .NET-ticks timestamp above 2^53. Range checks belong to what we encode
 * (`encodeRaw`), and `decodeRaw` stays strict through it.
 */
function read(hex: string): TronRawData {
  if (
    typeof hex !== 'string' ||
    hex.length === 0 ||
    hex.length > MAX_RAW_HEX ||
    !HEX.test(hex)
  ) {
    malformed();
  }
  // tronweb reads only the first contract, so count them here, SDK-free.
  if (onlyContract(fromHex(hex)) === null) malformed();
  let decoded: Decoded | undefined;
  for (const type of ['TransferContract', 'TriggerSmartContract']) {
    try {
      decoded = utils.deserializeTx.deserializeTransaction(type, hex) as Decoded;
      break;
    } catch {
      // Another contract type, or not a transaction at all.
    }
  }
  const entry = decoded?.contract?.[0];
  const value = entry?.parameter?.value;
  if (!decoded || !entry || !value) return malformed();
  const amount = value.amount;
  const contract: TronContract =
    entry.type === 'TransferContract'
      ? {
          type: 'TransferContract',
          owner: hexField(value.owner_address),
          to: hexField(value.to_address),
          // tronweb rounds an int64 above 2^53 - 1: read those exactly from the bytes.
          amount: exact(amount) ? BigInt(amount) : (transferAmount(hex) ?? malformed()),
        }
      : {
          type: 'TriggerSmartContract',
          owner: hexField(value.owner_address),
          contract: hexField(value.contract_address),
          data: hexField(value.data),
          // TRX or a TRC-10 token sent with the call, never dropped.
          ...(callValues(fromHex(hex)) ?? malformed()),
        };
  const raw: TronRawData = {
    refBlockBytes: hexField(decoded.ref_block_bytes),
    refBlockHash: hexField(decoded.ref_block_hash),
    // java-tron bounds `expiration` for every transaction in a block (`validateCommon`:
    // after the head block's time, at most `MAXIMUM_TIME_UNTIL_EXPIRATION` beyond it).
    expiration: exact(decoded.expiration) ? decoded.expiration : malformed(),
    // Client-set and unbounded (some wallets write .NET ticks): kept as tronweb reads it.
    timestamp: typeof decoded.timestamp === 'number' ? decoded.timestamp : malformed(),
    // Only the VM bounds `fee_limit`, for contract calls; on a TRX transfer it is client
    // data. One a number cannot hold exactly, or a negative one, is left out, never rounded.
    ...(exact(decoded.fee_limit) && decoded.fee_limit > 0
      ? { feeLimit: decoded.fee_limit }
      : {}),
    ...(decoded.data ? { data: hexField(decoded.data) } : {}),
    contract,
  };
  return raw;
}

function decodeRaw(hex: string): TronRawData {
  const raw = read(hex);
  let again: string;
  try {
    again = encodeRaw(raw);
  } catch {
    return malformed();
  }
  if (again !== hex.toLowerCase()) malformed();
  return raw;
}

/**
 * A tronweb `HttpProvider` whose `request()` goes to the transport, for the full
 * node, the solidity node and the event server. The SDK never sees a real URL or key.
 */
const BROADCASTS = /^\/wallet\/broadcast(?:transaction|hex)$/;

class TransportHttpProvider extends providers.HttpProvider {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    super(PLACEHOLDER_ORIGIN);
    this.#transport = transport;
  }

  override request<T = unknown>(
    url: string,
    payload: object = {},
    method = 'get',
  ): Promise<T> {
    const post = method.toLowerCase() === 'post';
    const [path = '/', search = ''] = url.split('?', 2);
    const query: Record<string, string> = Object.fromEntries(new URLSearchParams(search));
    if (!post) {
      for (const [key, value] of Object.entries(payload)) query[key] = String(value);
    }
    const route = path.startsWith('/') ? path : `/${path}`;
    const request: HttpRequest = {
      method: post ? 'POST' : 'GET',
      path: route,
      // A route label only for paths without identifiers: events and logs show the label.
      ...(/^\/wallet(?:solidity)?\/[a-z]+$/.test(route) ? { route } : {}),
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(post && Object.keys(payload).length > 0 ? { body: payload } : {}),
    };
    // Broadcasts are ambiguous on failure; everything else is a plain read.
    // No exactIntegers: tronweb expects plain numbers.
    return this.#transport.http<T>(
      request,
      BROADCASTS.test(route)
        ? { purpose: 'broadcast', retry: 'ambiguous-on-failure' }
        : { purpose: 'read', retry: 'safe' },
    );
  }
}

function readRaw(hex: string): TronRawData | null {
  try {
    return read(hex);
  } catch {
    return null;
  }
}

export const tronwebCodec: TronCodec = {
  library: 'tronweb',
  encodeRaw,
  decodeRaw,
  readRaw,
  createNative(transport) {
    const provider = new TransportHttpProvider(transport);
    const client = new TronWeb({
      fullNode: provider,
      solidityNode: provider,
      eventServer: provider,
    });
    return { client };
  },
};

/** The tronweb driver factory, which the manifest's `load()` requires. */
export const tronwebDriverFactory = tronDriverFactory(tronwebCodec);
