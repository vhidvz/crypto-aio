/**
 * A linear, SDK-free reader of untrusted transaction bytes.
 *
 * bitcoinjs-lib 7's `Transaction.fromBuffer` is quadratic in the number of inputs and
 * outputs: a 3.98 MB transaction with 92,500 outputs took 53 s. So bytes from a node, an
 * indexer or a coordinator are read here instead, in one pass. Every count is checked
 * against the bytes left before anything is kept, scripts and witness items are views into
 * the input (never copies), and the txid is hashed from the three stretches of the
 * serialization it covers, without copying them.
 *
 * The format is exactly bitcoind's `UnserializeTransaction` with witness support (as
 * `sendrawtransaction` decodes): an empty input list is followed by a flags byte; flags 1
 * marks the witness (BIP144), and a witness record whose stacks are all empty, or any other
 * flag, does not decode. Sizes are canonical CompactSize values of at most `MAX_SIZE`, and
 * nothing may follow the lock time. So when this reader refuses bytes, bitcoind refuses them
 * too, which lets the broadcaster check a node's `TX decode failed` itself: a node's
 * rejection is a claim, kept only when it holds for our own bytes.
 */
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, toHex } from '../../core/util/bytes';

/** Bitcoin Core's `MAX_BLOCK_SERIALIZED_SIZE`: no transaction's bytes are more. */
export const MAX_TX_BYTES = 4_000_000;
/**
 * Consensus: a transaction's weight (4 × its size without witness data, at least) is at most
 * `MAX_BLOCK_WEIGHT` (4,000,000), so a transaction a chain holds has at most 1,000,000 bytes
 * without its witness.
 */
export const MAX_STRIPPED_BYTES = 1_000_000;
/** bitcoind's `MAX_SIZE`: the largest CompactSize a deserializer accepts. */
const MAX_SIZE = 0x02000000;
/** The fewest bytes an input (outpoint, empty script, sequence) and an output can take. */
const MIN_INPUT = 41;
const MIN_OUTPUT = 9;

export interface ParsedInput {
  /** The previous txid, in display order (the reverse of the serialized hash). */
  readonly txid: string;
  /** The previous transaction's hash as serialized (internal byte order): a view. */
  readonly hash: Uint8Array;
  readonly vout: number;
  readonly script: Uint8Array;
  readonly sequence: number;
  readonly witness: readonly Uint8Array[];
}

export interface ParsedOutput {
  /** As bitcoind reads it: a signed 64-bit integer. */
  readonly value: bigint;
  readonly script: Uint8Array;
}

export interface ParsedTx {
  readonly txid: string;
  readonly version: number;
  readonly locktime: number;
  readonly inputs: readonly ParsedInput[];
  readonly outputs: readonly ParsedOutput[];
  readonly hasWitness: boolean;
  /** The size without witness data (bitcoind's `TX_NO_WITNESS` serialization). */
  readonly strippedSize: number;
  /** The output list as serialized (its count, then each output): a view. */
  readonly outputBytes: Uint8Array;
  /** The serialization without witness data (BIP174 `non_witness_utxo`). */
  stripped(): Uint8Array;
}

export interface ReadOptions {
  /**
   * The most bytes without witness data: `MAX_STRIPPED_BYTES` (the default) for data a chain
   * holds; the broadcaster reads what it sent with `MAX_TX_BYTES`, so every size bitcoind
   * decodes is read (bitcoind refuses a larger one later, as `bad-txns-oversize`).
   */
  readonly maxStripped?: number;
}

class Malformed extends Error {}

/** Double SHA-256 of the given stretches, as one message. */
function hash256(parts: readonly Uint8Array[]): Uint8Array {
  const inner = sha256.create();
  for (const part of parts) inner.update(part);
  return sha256(inner.digest());
}

/** A txid (or block hash) in display order. */
const displayHex = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

/** The txid of a serialization without witness data, given as consecutive stretches. */
export const txidOfParts = (parts: readonly Uint8Array[]): string =>
  displayHex(hash256(parts));

/** A little-endian 32-bit field, as bitcoind writes it. */
export function writeU32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

/** A CompactSize, as bitcoind writes it (at most `MAX_SIZE` here). */
export function writeSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  return concatBytes(Uint8Array.of(0xfe), writeU32(n));
}

/** Transaction bytes, read in one pass; `undefined` when bitcoind would not decode them. */
export function readTx(
  bytes: Uint8Array,
  options: ReadOptions = {},
): ParsedTx | undefined {
  const maxStripped = options.maxStripped ?? MAX_STRIPPED_BYTES;
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_TX_BYTES) return undefined;
  try {
    return parse(bytes, maxStripped);
  } catch (error) {
    if (error instanceof Malformed) return undefined;
    throw error;
  }
}

/**
 * Transaction hex (either case, no prefix), capped at `MAX_TX_BYTES` before it is
 * decoded, then read by `readTx`. Node's hex decoder is native and linear, and stops at
 * the first pair that is not hex, so a short result means the text was not plain hex.
 */
export function readTxHex(hex: string, options: ReadOptions = {}): ParsedTx | undefined {
  if (typeof hex !== 'string' || hex.length > 2 * MAX_TX_BYTES) return undefined;
  if (hex.length % 2 !== 0) return undefined;
  const decoded = Buffer.from(hex, 'hex');
  if (decoded.length * 2 !== hex.length) return undefined;
  return readTx(
    new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.length),
    options,
  );
}

function parse(bytes: Uint8Array, maxStripped: number): ParsedTx {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number): void => {
    if (n < 0 || pos + n > bytes.length) throw new Malformed();
  };
  const u8 = (): number => {
    need(1);
    return bytes[pos++] as number;
  };
  const u32 = (): number => {
    need(4);
    const value = view.getUint32(pos, true);
    pos += 4;
    return value;
  };
  const slice = (n: number): Uint8Array => {
    need(n);
    const part = bytes.subarray(pos, pos + n);
    pos += n;
    return part;
  };
  /** A canonical CompactSize of at most `MAX_SIZE` (bitcoind's `ReadCompactSize`). */
  const size = (): number => {
    const first = u8();
    let value: number;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      need(2);
      value = view.getUint16(pos, true);
      pos += 2;
      if (value < 0xfd) throw new Malformed();
    } else if (first === 0xfe) {
      value = u32();
      if (value < 0x1_0000) throw new Malformed();
    } else {
      throw new Malformed(); // 8 bytes: at least 2^32, beyond MAX_SIZE
    }
    if (value > MAX_SIZE) throw new Malformed();
    return value;
  };
  /** Bounds a count by the bytes left, before anything is kept for it. */
  const count = (least: number): number => {
    const n = size();
    if (n * least > bytes.length - pos) throw new Malformed();
    return n;
  };

  // `skipped`: the marker and flag bytes, which the stripped serialization leaves out.
  let skipped = 0;
  const strippedSoFar = (): number => pos - skipped + 4; // with the lock time still to come
  const version = u32() | 0;
  let vinStart = pos;
  let inputCount = count(MIN_INPUT);
  let extended = false;
  let outputsKnown = true;
  if (inputCount === 0) {
    const flags = u8();
    if (flags === 0) {
      outputsKnown = false; // bitcoind reads no output list after an empty one and no flags
    } else {
      if (flags !== 1) throw new Malformed(); // unknown optional data
      extended = true;
      skipped = 2;
      vinStart = pos;
      inputCount = count(MIN_INPUT);
    }
  }
  const inputs: {
    txid: string;
    hash: Uint8Array;
    vout: number;
    script: Uint8Array;
    sequence: number;
    witness: readonly Uint8Array[];
  }[] = [];
  for (let i = 0; i < inputCount; i++) {
    const hash = slice(32);
    const vout = u32();
    const script = slice(size());
    const sequence = u32();
    inputs.push({ txid: displayHex(hash), hash, vout, script, sequence, witness: [] });
    if (strippedSoFar() > maxStripped) throw new Malformed();
  }
  const outputStart = pos;
  const outputs: ParsedOutput[] = [];
  if (outputsKnown) {
    const outputCount = count(MIN_OUTPUT);
    for (let i = 0; i < outputCount; i++) {
      need(8);
      const value = view.getBigInt64(pos, true);
      pos += 8;
      outputs.push({ value, script: slice(size()) });
      if (strippedSoFar() > maxStripped) throw new Malformed();
    }
  }
  const outputEnd = pos;
  let hasWitness = false;
  if (extended) {
    for (const input of inputs) {
      const items = count(1);
      const stack: Uint8Array[] = [];
      for (let i = 0; i < items; i++) stack.push(slice(size()));
      input.witness = stack;
      if (items > 0) hasWitness = true;
    }
    if (!hasWitness) throw new Malformed(); // a superfluous witness record
  }
  const locktime = u32();
  if (pos !== bytes.length) throw new Malformed();
  const parts = extended
    ? [bytes.subarray(0, 4), bytes.subarray(vinStart, outputEnd), bytes.subarray(pos - 4)]
    : [bytes];
  const stripped = parts.reduce((sum, part) => sum + part.length, 0);
  if (stripped > maxStripped) throw new Malformed();
  return {
    txid: txidOfParts(parts),
    version,
    locktime,
    inputs,
    outputs,
    hasWitness,
    strippedSize: stripped,
    outputBytes: bytes.subarray(outputStart, outputEnd),
    stripped: () => (parts.length === 1 ? bytes : concatBytes(...parts)),
  };
}
