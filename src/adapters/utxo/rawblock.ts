/**
 * A linear, SDK-free reader of untrusted block bytes (Esplora's `/block/:hash/raw`), and the
 * checks that bind a block's transactions to its header.
 *
 * A block hash is the double SHA-256 of the 80-byte header, and the header commits to the
 * transactions through the merkle root of their txids, and (BIP141) to their witnesses
 * through the coinbase's witness commitment. So bytes that hash to the block asked for and
 * pass `commitsToTransactions` are that block's transactions, byte for byte, whoever served
 * them: an indexer can neither add, drop nor alter one. bitcoinjs-lib's `Block.fromBuffer`
 * copies the rest of the block for every transaction it reads (quadratic in the block's
 * size), so each transaction is read here by `rawtx.ts`, in one pass over views of the bytes.
 *
 * The format is bitcoind's: the header, a canonical CompactSize count of at most `MAX_SIZE`,
 * then each transaction with witness support, and nothing after the last one.
 */
import { equalBytes } from '../../core/util/bytes';
import { displayHex, hash256, readTxAt, type ParsedInput, type ParsedTx } from './rawtx';

/** Bitcoin Core's `MAX_BLOCK_SERIALIZED_SIZE`: no block's bytes are more. */
export const MAX_BLOCK_BYTES = 4_000_000;
const HEADER = 80;
/** bitcoind's `MAX_SIZE`: the largest CompactSize a deserializer accepts. */
const MAX_SIZE = 0x02000000;
/** The fewest bytes `rawtx.ts` decodes as a transaction (version, two zero bytes, lock time). */
const MIN_TX = 10;
/** BIP141: an output script of at least 38 bytes that starts `OP_RETURN 0x24 aa21a9ed`. */
const COMMITMENT_HEADER = Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed);
const COMMITMENT_SIZE = 38;
const ZERO_HASH = new Uint8Array(32);

export interface RawBlock {
  /** The block hash in display order: the double SHA-256 of the header. */
  readonly hash: string;
  /** The previous block's hash in display order (zeros for a genesis block). */
  readonly parentHash: string;
  /** The header's time, in seconds. */
  readonly time: number;
  /** The header's merkle root of the txids, in internal byte order. */
  readonly merkleRoot: Uint8Array;
  /** Every transaction, the coinbase first, as the bytes hold them. */
  readonly txs: readonly ParsedTx[];
}

/** An input that spends no output (`COutPoint::IsNull`): a coinbase's. */
export const isNullOutpoint = (input: ParsedInput): boolean =>
  input.vout === 0xffffffff && equalBytes(input.hash, ZERO_HASH);

/** Block bytes, read in one pass; `undefined` when bitcoind would not decode them. */
export function readBlock(bytes: Uint8Array): RawBlock | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (bytes.length < HEADER + 1 || bytes.length > MAX_BLOCK_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = HEADER;
  // A canonical CompactSize of at most `MAX_SIZE` (bitcoind's `ReadCompactSize`).
  const first = bytes[pos++] as number;
  let count = first;
  if (first === 0xfd) {
    if (pos + 2 > bytes.length) return undefined;
    count = view.getUint16(pos, true);
    pos += 2;
    if (count < 0xfd) return undefined;
  } else if (first === 0xfe) {
    if (pos + 4 > bytes.length) return undefined;
    count = view.getUint32(pos, true);
    pos += 4;
    if (count < 0x1_0000) return undefined;
  } else if (first === 0xff) {
    return undefined; // 8 bytes: at least 2^32, beyond MAX_SIZE
  }
  // Every block has a coinbase, and the count is bounded by the bytes left before
  // anything is kept for it.
  if (count < 1 || count > MAX_SIZE || count * MIN_TX > bytes.length - pos) {
    return undefined;
  }
  const txs: ParsedTx[] = [];
  for (let i = 0; i < count; i++) {
    const tx = readTxAt(bytes, pos);
    if (!tx) return undefined;
    txs.push(tx);
    pos += tx.bytes.length;
  }
  if (pos !== bytes.length) return undefined;
  const header = bytes.subarray(0, HEADER);
  return {
    hash: displayHex(hash256([header])),
    parentHash: displayHex(header.subarray(4, 36)),
    time: view.getUint32(68, true),
    merkleRoot: header.subarray(36, 68),
    txs,
  };
}

/**
 * Bitcoin Core's `ComputeMerkleRoot`: the root of `leaves`, each level's odd last node
 * paired with itself, and whether a level holds two equal nodes at a pair's places. That
 * flags CVE-2012-2459: a list whose last transactions are repeated has the root of the list
 * without them, so equal pairs are refused rather than read as a different block.
 */
export function merkleRootOf(leaves: readonly Uint8Array[]): {
  readonly root: Uint8Array;
  readonly mutated: boolean;
} {
  let level = [...leaves];
  let mutated = false;
  while (level.length > 1) {
    for (let i = 0; i + 1 < level.length; i += 2) {
      if (equalBytes(level[i] as Uint8Array, level[i + 1] as Uint8Array)) mutated = true;
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Uint8Array;
      next.push(hash256([left, level[i + 1] ?? left]));
    }
    level = next;
  }
  return { root: level[0] ?? ZERO_HASH, mutated };
}

/**
 * Whether `block`'s transactions are the ones its header commits to, as bitcoind's
 * `CheckMerkleRoot`, `bad-cb-missing` and `CheckWitnessMalleation` check them:
 * - the merkle root of the txids is the header's, with no repeated pair (CVE-2012-2459) and
 *   no txid twice: no valid block holds one twice;
 * - the first transaction is a coinbase (one input, spending nothing). A 64-byte
 *   transaction's txid is the hash of two merkle nodes, so a forged list could stand in a
 *   subtree; its leftmost leaf would then have to be a coinbase whose null outpoint is 36
 *   fixed bytes of hash output, which no one can find;
 * - when any transaction carries a witness, the coinbase commits to every witness (BIP141):
 *   its last output that starts `OP_RETURN aa21a9ed` holds the double SHA-256 of the
 *   wtxids' merkle root (the coinbase's taken as zero) and the coinbase's one 32-byte
 *   witness item. A block with no witness at all is checked by its txids alone: an
 *   earlier block's coinbase may carry a commitment that segwit's rules did not cover yet.
 */
export function commitsToTransactions(block: RawBlock): boolean {
  const { txs } = block;
  const coinbase = txs[0];
  const input = coinbase?.inputs[0];
  if (!coinbase || coinbase.inputs.length !== 1 || !input || !isNullOutpoint(input)) {
    return false;
  }
  if (new Set(txs.map((tx) => tx.txid)).size !== txs.length) return false;
  const ids = merkleRootOf(txs.map((tx) => tx.hash));
  if (ids.mutated || !equalBytes(ids.root, block.merkleRoot)) return false;
  if (!txs.some((tx) => tx.hasWitness)) return true;
  let commitment: Uint8Array | undefined;
  for (const output of coinbase.outputs) {
    const script = output.script;
    if (
      script.length >= COMMITMENT_SIZE &&
      equalBytes(script.subarray(0, COMMITMENT_HEADER.length), COMMITMENT_HEADER)
    ) {
      commitment = script.subarray(COMMITMENT_HEADER.length, COMMITMENT_SIZE);
    }
  }
  const reserved = input.witness;
  if (!commitment || reserved.length !== 1 || reserved[0]?.length !== 32) return false;
  const witnesses = merkleRootOf(
    txs.map((tx, i) =>
      i === 0 ? ZERO_HASH : tx.hasWitness ? hash256([tx.bytes]) : tx.hash,
    ),
  );
  return equalBytes(hash256([witnesses.root, reserved[0]]), commitment);
}
