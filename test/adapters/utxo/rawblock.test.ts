import {
  MAX_BLOCK_BYTES,
  commitsToTransactions,
  merkleRootOf,
  readBlock,
} from '../../../src/adapters/utxo/rawblock';
import { scriptType } from '../../../src/adapters/utxo/decode';
import { bitcoin, type Transaction } from '../../../src/adapters/utxo/sdk';
import { concatBytes, fromHex, toHex } from '../../../src/core/util/bytes';
import { merkleRoot as coreMerkleRoot } from './support/node';
import { SIGNET_70000 } from './support/signet';
import { fundingTx, signedSpend } from './support/tx';
import { TEST_KEY } from './support/vectors';

const WITNESS_COMMITMENT = Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed);
const hash256 = (bytes: Uint8Array) => bitcoin.crypto.hash256(bytes);

/** A coinbase (one input spending nothing), with a witness reserved value when given. */
function coinbase(salt: number, reserved?: Uint8Array): Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(
    new Uint8Array(32),
    0xffffffff,
    0xffffffff,
    Uint8Array.of(0x01, salt, 0x51),
  );
  tx.addOutput(new Uint8Array(22).fill(9), 50_0000_0000n);
  if (reserved) tx.setWitness(0, [reserved]);
  return tx;
}

/** A segwit spend, so its block needs a witness commitment. */
const segwitSpend = (salt: number): Transaction =>
  bitcoin.Transaction.fromHex(
    signedSpend(
      TEST_KEY,
      [[salt.toString(16).padStart(64, '0'), 0, 10_000n]],
      [[new Uint8Array(22).fill(2), 9_000n]],
    ),
  );

/**
 * The BIP141 commitment output to the witnesses of `txs`, computed as bitcoind does from
 * the coinbase's reserved value (a coinbase-shaped transaction elsewhere in the block keeps
 * its own wtxid, which bitcoinjs would take as zero).
 */
function commitment(
  txs: readonly Transaction[],
  reserved = new Uint8Array(32),
): Uint8Array {
  const wtxids = txs.map((tx, i) =>
    i === 0 ? new Uint8Array(32) : hash256(tx.toBuffer()),
  );
  return concatBytes(
    WITNESS_COMMITMENT,
    hash256(concatBytes(coreMerkleRoot(wtxids), reserved)),
  );
}

/** A block of `txs` under a header that commits to their txids (bitcoinjs computes the root). */
function block(txs: Transaction[]): Uint8Array {
  const b = new bitcoin.Block();
  b.version = 0x20000000;
  b.prevHash = new Uint8Array(32).fill(7);
  b.merkleRoot = bitcoin.Block.calculateMerkleRoot(txs);
  b.timestamp = 1_700_000_000;
  b.bits = 0x207fffff;
  b.nonce = 1;
  b.transactions = txs;
  return b.toBuffer();
}

/** A block of a coinbase committing to the witnesses of `rest`, then `rest`. */
function segwitBlock(rest: Transaction[]): Uint8Array {
  const cb = coinbase(1, new Uint8Array(32));
  cb.addOutput(commitment([cb, ...rest]), 0n);
  return block([cb, ...rest]);
}

describe('the linear block reader', () => {
  it('reads a real block: its hash, parent, time and transactions (signet 70000)', () => {
    const raw = readBlock(fromHex(SIGNET_70000.raw));
    expect(raw).toMatchObject({
      hash: SIGNET_70000.hash,
      parentHash: SIGNET_70000.header.previousblockhash,
      time: SIGNET_70000.header.timestamp,
    });
    expect(toHex(Uint8Array.from(raw!.merkleRoot).reverse())).toBe(
      SIGNET_70000.header.merkle_root,
    );
    expect(raw!.txs.map((tx) => tx.txid)).toEqual(SIGNET_70000.page.map((tx) => tx.txid));
    expect(raw!.txs.map((tx) => tx.strippedSize * 3 + tx.bytes.length)).toEqual(
      SIGNET_70000.page.map((tx) => tx.weight),
    );
    // Its transactions are the ones its header commits to, witnesses included.
    expect(raw!.txs.every((tx) => tx.hasWitness)).toBe(true);
    expect(commitsToTransactions(raw!)).toBe(true);
  });

  it('reads blocks as bitcoinjs-lib builds them', () => {
    const funding = fundingTx(new Uint8Array(22).fill(1), 1_000n, 5);
    for (const bytes of [
      block([coinbase(1)]),
      block([coinbase(2), funding]),
      segwitBlock([segwitSpend(1), funding, segwitSpend(2)]),
    ]) {
      const parsed = bitcoin.Block.fromBuffer(bytes);
      const raw = readBlock(bytes);
      expect(raw?.hash).toBe(parsed.getId());
      expect(raw?.txs.map((tx) => tx.txid)).toEqual(
        parsed.transactions!.map((tx) => tx.getId()),
      );
      expect(commitsToTransactions(raw!)).toBe(true);
    }
  });

  it('reads a count of 253 transactions or more (a 3-byte CompactSize)', () => {
    const txs = [
      coinbase(1),
      ...Array.from({ length: 299 }, (_, i) => fundingTx(new Uint8Array(22), 1n, i + 1)),
    ];
    const bytes = block(txs);
    expect(bytes[80]).toBe(0xfd);
    const raw = readBlock(bytes);
    expect(raw?.txs).toHaveLength(300);
    expect(commitsToTransactions(raw!)).toBe(true);
  });

  it('refuses bytes bitcoind would not decode as a block', () => {
    const bytes = block([coinbase(1), fundingTx(new Uint8Array(22), 1n)]);
    const header = bytes.subarray(0, 80);
    const txs = bytes.subarray(81);
    for (const bad of [
      new Uint8Array(0),
      header,
      bytes.subarray(0, bytes.length - 1), // truncated
      concatBytes(bytes, Uint8Array.of(0)), // a byte after the last transaction
      concatBytes(header, Uint8Array.of(0)), // no transaction: not even a coinbase
      concatBytes(header, Uint8Array.of(3), txs), // more transactions than it holds
      // Counts bitcoind's `ReadCompactSize` refuses: non-canonical, cut short, or beyond
      // `MAX_SIZE`.
      concatBytes(header, Uint8Array.of(0xfd, 0x02, 0x00), txs),
      concatBytes(header, Uint8Array.of(0xfe, 0x02, 0x00, 0x00, 0x00), txs),
      concatBytes(header, Uint8Array.of(0xfd, 0x02)),
      concatBytes(header, Uint8Array.of(0xfe, 0x02, 0x00)),
      concatBytes(header, Uint8Array.of(0xfe, 0x00, 0x00, 0x00, 0x80), txs),
      concatBytes(header, Uint8Array.of(0xff), new Uint8Array(8).fill(1), txs),
    ]) {
      expect(readBlock(bad)).toBeUndefined();
    }
    expect(readBlock(new Uint8Array(MAX_BLOCK_BYTES + 1))).toBeUndefined();
    expect(readBlock('00' as unknown as Uint8Array)).toBeUndefined();
  });
});

describe("an output's Esplora type, named from its script", () => {
  it('names the types as Blockstream electrs does', () => {
    const fill = (n: number) => new Uint8Array(n).fill(7);
    const cases: [Uint8Array, string][] = [
      [new Uint8Array(0), 'empty'],
      [Uint8Array.of(0x6a, 0x04, 1, 2, 3, 4), 'op_return'],
      [concatBytes(Uint8Array.of(33), fill(33), Uint8Array.of(0xac)), 'p2pk'],
      [concatBytes(Uint8Array.of(65), fill(65), Uint8Array.of(0xac)), 'p2pk'],
      [
        concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), fill(20), Uint8Array.of(0x88, 0xac)),
        'p2pkh',
      ],
      [concatBytes(Uint8Array.of(0xa9, 0x14), fill(20), Uint8Array.of(0x87)), 'p2sh'],
      [concatBytes(Uint8Array.of(0x00, 0x14), fill(20)), 'v0_p2wpkh'],
      [concatBytes(Uint8Array.of(0x00, 0x20), fill(32)), 'v0_p2wsh'],
      [concatBytes(Uint8Array.of(0x51, 0x20), fill(32)), 'v1_p2tr'],
      // A future witness version, a bare OP_TRUE, near misses of each template.
      [concatBytes(Uint8Array.of(0x52, 0x20), fill(32)), 'unknown'],
      [Uint8Array.of(0x51), 'unknown'],
      [concatBytes(Uint8Array.of(33), fill(33), Uint8Array.of(0xad)), 'unknown'],
      [
        concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), fill(20), Uint8Array.of(0x88, 0xad)),
        'unknown',
      ],
      [concatBytes(Uint8Array.of(0xa9, 0x14), fill(20), Uint8Array.of(0x88)), 'unknown'],
      [concatBytes(Uint8Array.of(0x00, 0x14), fill(21)), 'unknown'],
      [concatBytes(Uint8Array.of(0x00, 0x20), fill(31)), 'unknown'],
    ];
    expect(cases.map(([script]) => scriptType(script))).toEqual(cases.map(([, t]) => t));
  });
});

describe('a block commits to its transactions', () => {
  it('computes merkle roots as bitcoind does, flagging a repeated pair', () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) => hash256(Uint8Array.of(i)));
      const { root, mutated } = merkleRootOf(leaves);
      expect(toHex(root)).toBe(toHex(coreMerkleRoot(leaves)));
      expect(mutated).toBe(false);
    }
    const [a, b, c] = [1, 2, 3].map((i) => hash256(Uint8Array.of(i))) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    // CVE-2012-2459: [a, b, c] and [a, b, c, c] have one root.
    expect(toHex(merkleRootOf([a, b, c, c]).root)).toBe(
      toHex(merkleRootOf([a, b, c]).root),
    );
    expect(merkleRootOf([a, b, c, c]).mutated).toBe(true);
  });

  it('refuses a list whose last transactions are repeated (same root and hash)', () => {
    const txs = [
      coinbase(1),
      fundingTx(new Uint8Array(22), 1n, 1),
      fundingTx(new Uint8Array(22), 2n, 2),
    ];
    const honest = block(txs);
    const twice = concatBytes(
      honest.subarray(0, 80),
      Uint8Array.of(4),
      honest.subarray(81),
      txs[2]!.toBuffer(),
    );
    const raw = readBlock(twice);
    expect(raw?.hash).toBe(readBlock(honest)?.hash);
    expect(commitsToTransactions(readBlock(honest)!)).toBe(true);
    expect(commitsToTransactions(raw!)).toBe(false);
  });

  it('refuses transactions other than the ones the merkle root commits to', () => {
    const txs = [coinbase(1), fundingTx(new Uint8Array(22), 1n, 1)];
    const honest = block(txs);
    const other = fundingTx(new Uint8Array(22).fill(1), 1n, 1).toBuffer();
    const swapped = concatBytes(honest.subarray(0, 81 + txs[0]!.byteLength()), other);
    expect(commitsToTransactions(readBlock(swapped)!)).toBe(false);
  });

  it('refuses a block whose first transaction is not a coinbase', () => {
    // A header that commits to them, but no coinbase first: never a block of a chain.
    for (const txs of [
      [fundingTx(new Uint8Array(22), 1n, 1)],
      [segwitSpend(3), coinbase(1)],
    ]) {
      expect(commitsToTransactions(readBlock(block(txs))!)).toBe(false);
    }
    const twoInputs = coinbase(1);
    twoInputs.addInput(new Uint8Array(32).fill(1), 0);
    expect(commitsToTransactions(readBlock(block([twoInputs]))!)).toBe(false);
  });

  it('binds witnesses through the coinbase commitment (BIP141)', () => {
    const spend = segwitSpend(1);
    const honest = segwitBlock([spend]);
    expect(commitsToTransactions(readBlock(honest)!)).toBe(true);
    // Another witness for the same transaction: the txids, so the hash, are unchanged.
    const cb = bitcoin.Block.fromBuffer(honest).transactions![0]!;
    const rewitnessed = spend.clone();
    rewitnessed.setWitness(0, [...spend.ins[0]!.witness, Uint8Array.of(1)]);
    const altered = concatBytes(
      honest.subarray(0, 81 + cb.byteLength()),
      rewitnessed.toBuffer(),
    );
    expect(readBlock(altered)?.hash).toBe(readBlock(honest)?.hash);
    expect(commitsToTransactions(readBlock(altered)!)).toBe(false);
    // A witness without a commitment.
    expect(commitsToTransactions(readBlock(block([coinbase(1), spend]))!)).toBe(false);
    // A reserved value that is not exactly one 32-byte item.
    for (const reserved of [
      [new Uint8Array(31)],
      [new Uint8Array(32), new Uint8Array(32)],
    ]) {
      const bad = coinbase(1, new Uint8Array(32));
      bad.addOutput(commitment([bad, spend], reserved[0]), 0n);
      bad.setWitness(0, reserved);
      expect(commitsToTransactions(readBlock(block([bad, spend]))!)).toBe(false);
    }
    // The last commitment output counts, as bitcoind's `GetWitnessCommitmentIndex` reads it.
    const decoy = Uint8Array.from(commitment([coinbase(1), spend])).fill(5, 6);
    for (const [order, committed] of [
      ['decoy first', true],
      ['decoy last', false],
    ] as const) {
      const two = coinbase(1, new Uint8Array(32));
      const real = commitment([two, spend]);
      for (const script of order === 'decoy first' ? [decoy, real] : [real, decoy]) {
        two.addOutput(script, 0n);
      }
      expect(commitsToTransactions(readBlock(block([two, spend]))!)).toBe(committed);
    }
    // A block without any witness is held to its txids alone.
    expect(commitsToTransactions(readBlock(block([coinbase(2)]))!)).toBe(true);
  });
});
