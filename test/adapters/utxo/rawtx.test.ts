import {
  MAX_STRIPPED_BYTES,
  MAX_TX_BYTES,
  readTx,
  readTxHex,
} from '../../../src/adapters/utxo/rawtx';
import { bitcoin, type Transaction } from '../../../src/adapters/utxo/sdk';
import { concatBytes, fromHex, toHex } from '../../../src/core/util/bytes';
import {
  fundingTx,
  manyOutputs,
  signedSpend,
  txidOfStripped as txidOf,
  u32,
} from './support/tx';
import { OTHER_KEY, TEST_KEY } from './support/vectors';

describe('the linear transaction reader', () => {
  it('reads ordinary transactions exactly as bitcoinjs does', () => {
    const legacy = fundingTx(new Uint8Array(22).fill(1), 50_000n, 3);
    const funding = fundingTx(
      bitcoin.address.toOutputScript(
        'bcrt1qelwllzs5wpgtrstfn2hda98vwtqqq2anllgcxd',
        bitcoin.networks.regtest,
      ),
      90_000n,
      4,
    );
    const segwit = bitcoin.Transaction.fromHex(
      signedSpend(
        TEST_KEY,
        [
          [funding.getId(), 0, 90_000n],
          ['ab'.repeat(32), 3, 10_000n],
        ],
        [
          [new Uint8Array(22).fill(2), 60_000n],
          [new Uint8Array(34).fill(3), 30_000n],
        ],
      ),
    );
    const other = bitcoin.Transaction.fromHex(
      signedSpend(
        OTHER_KEY,
        [['cd'.repeat(32), 1, 5_000n]],
        [[new Uint8Array(22), 4_000n]],
      ),
    );
    for (const tx of [legacy, segwit, other] as Transaction[]) {
      const parsed = readTx(tx.toBuffer());
      expect(parsed?.txid).toBe(tx.getId());
      expect(parsed?.version).toBe(tx.version);
      expect(parsed?.locktime).toBe(tx.locktime);
      expect(parsed?.hasWitness).toBe(tx.hasWitnesses());
      expect(parsed?.strippedSize).toBe(tx.byteLength(false));
      expect(toHex(parsed!.stripped())).toBe(
        toHex(
          (() => {
            const bare = tx.clone();
            bare.ins.forEach((_, i) => bare.setWitness(i, []));
            return bare.toBuffer();
          })(),
        ),
      );
      expect(
        parsed?.inputs.map((i) => [
          i.txid,
          i.vout,
          toHex(i.script),
          i.sequence,
          i.witness.map((w) => toHex(w)),
        ]),
      ).toEqual(
        tx.ins.map((i) => [
          toHex(Uint8Array.from(i.hash).reverse()),
          i.index,
          toHex(i.script),
          i.sequence,
          i.witness.map((w) => toHex(w)),
        ]),
      );
      expect(parsed?.outputs.map((o) => [o.value, toHex(o.script)])).toEqual(
        tx.outs.map((o) => [o.value, toHex(o.script)]),
      );
      expect(readTxHex(tx.toHex())?.txid).toBe(tx.getId());
      expect(readTxHex(tx.toHex().toUpperCase())?.txid).toBe(tx.getId());
    }
  });

  it("decodes exactly what bitcoind's sendrawtransaction decodes", () => {
    const { bytes } = manyOutputs(2);
    const good = toHex(bytes);
    // No inputs and no flags: bitcoind reads no output list (then CheckTransaction refuses).
    const empty = readTx(concatBytes(u32(2), Uint8Array.of(0, 0), u32(0)));
    expect([empty?.inputs.length, empty?.outputs.length, empty?.strippedSize]).toEqual([
      0, 0, 10,
    ]);
    // Negative and huge values are read as bitcoind reads them: signed 64-bit.
    const negative = concatBytes(
      bytes.subarray(0, bytes.length - 4 - 18),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0),
      bytes.subarray(bytes.length - 4 - 9),
    );
    expect(readTx(negative)?.outputs[0]?.value).toBe(-1n);
    // A witness record under any flags but exactly 1 is unknown optional data to bitcoind,
    // even when the witness itself is well formed.
    const witnessed = manyOutputs(2, 10).bytes;
    expect(readTx(witnessed)?.hasWitness).toBe(true);
    for (const flags of [0x02, 0x03, 0x81]) {
      const other = Uint8Array.from(witnessed);
      other[5] = flags;
      expect(readTx(other)).toBeUndefined();
    }
    for (const hex of [
      `${good}00`, // a byte after the lock time
      good.slice(0, -2), // truncated
      `${good.slice(0, 8)}0002${good.slice(8)}`, // flags other than 1
      // flags 1 whose witness stacks are all empty (a superfluous witness record)
      `${good.slice(0, 8)}0001${good.slice(8, -8)}00${good.slice(-8)}`,
      `${good.slice(0, 8)}fd0100${good.slice(10)}`, // a non-canonical CompactSize
      `${good.slice(0, 8)}ff0100000000000000${good.slice(10)}`, // an 8-byte CompactSize
      `${good.slice(0, 8)}fe01000002${good.slice(10)}`, // a count above MAX_SIZE
      `${good.slice(0, 8)}fe00000100${good.slice(10)}`, // a count the bytes cannot hold
      'zz',
      `0x${good}`,
      good.slice(1),
    ]) {
      expect(readTxHex(hex)).toBeUndefined();
    }
  });

  it('caps the bytes, and the part without witness at what a chain can hold', () => {
    const { bytes } = manyOutputs(2);
    expect(readTx(concatBytes(bytes, new Uint8Array(MAX_TX_BYTES)))).toBeUndefined();
    expect(readTxHex('00'.repeat(MAX_TX_BYTES + 1))).toBeUndefined();
    // Just over a million bytes without witness data: not a transaction any chain holds,
    // but the broadcaster reads it (bitcoind decodes it, then refuses it as oversize).
    const big = manyOutputs(Math.ceil(MAX_STRIPPED_BYTES / 9));
    expect(big.stripped.length).toBeGreaterThan(MAX_STRIPPED_BYTES);
    expect(readTx(big.bytes)).toBeUndefined();
    expect(readTx(big.bytes, { maxStripped: MAX_TX_BYTES })?.txid).toBe(
      txidOf(big.stripped),
    );
    // A large witness is chain data: read.
    const witnessed = manyOutputs(2, 3_900_000);
    const parsed = readTx(witnessed.bytes);
    expect(parsed?.txid).toBe(txidOf(witnessed.stripped));
    expect(parsed?.strippedSize).toBe(witnessed.stripped.length);
  });

  it('reads or refuses a hostile 3.9 MB transaction in well under a second, never through bitcoinjs', () => {
    /** The best of three runs, so a moment of load elsewhere does not decide the bound. */
    const fastest = (work: () => unknown): number =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const started = performance.now();
          work();
          return performance.now() - started;
        }),
      );
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    try {
      // 433,000 outputs in 3.9 MB: bitcoinjs' quadratic decoder would take minutes.
      const hostile = toHex(manyOutputs(433_000).bytes);
      expect(hostile.length).toBeGreaterThan(7_780_000);
      expect(readTxHex(hostile)).toBeUndefined();
      expect(fastest(() => readTxHex(hostile))).toBeLessThan(1_000);
      // The most outputs a real transaction's million bytes can hold, padded with a witness
      // to 3.9 MB: decoded, and its txid hashed from the bytes.
      const most = manyOutputs(110_000, 2_900_000);
      const hex = toHex(most.bytes);
      expect(hex.length).toBeGreaterThan(7_780_000);
      const parsed = readTxHex(hex);
      expect(parsed?.outputs).toHaveLength(110_000);
      expect(parsed?.txid).toBe(txidOf(most.stripped));
      expect(fastest(() => readTxHex(hex))).toBeLessThan(1_000);
      expect(fromBuffer).not.toHaveBeenCalled();
    } finally {
      fromBuffer.mockRestore();
    }
  });

  it('keeps views, never copies, of the scripts it reads', () => {
    const { bytes } = manyOutputs(3);
    const parsed = readTx(bytes);
    expect(parsed?.inputs[0]?.hash.buffer).toBe(bytes.buffer);
    expect(parsed?.outputs[2]?.script.buffer).toBe(bytes.buffer);
    expect(fromHex(toHex(parsed!.stripped()))).toEqual(bytes);
  });
});
