/** Test transactions: a funding transaction for a script, and a signer for bitcoinjs' own PSBT signing. */
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bitcoin, type Transaction } from '../../../../src/adapters/utxo/sdk';
import { tweakPrivateKey } from '../../../../src/core/signing/local';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, fromHex, toHex } from '../../../../src/core/util/bytes';

/** A transaction with one made-up input that pays `value` to `script` (output 0). */
export function fundingTx(script: Uint8Array, value: bigint, salt = 0): Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(
    fromHex(salt.toString(16).padStart(64, '0')),
    0,
    0xffffffff,
    Uint8Array.of(0x51),
  );
  tx.addOutput(script, value);
  return tx;
}

/** bitcoinjs' `Signer` over a raw key (RFC 6979 ECDSA, so signatures are deterministic). */
export function nativeSigner(key: Uint8Array) {
  return {
    publicKey: secp256k1.getPublicKey(key, true),
    sign: (hash: Uint8Array) =>
      secp256k1.sign(hash, key, { lowS: true }).toCompactRawBytes(),
  };
}

/** A key-path taproot signer for bitcoinjs: the BIP341-tweaked key. */
export function nativeTaprootSigner(key: Uint8Array, tweak: Uint8Array) {
  const tweaked = tweakPrivateKey(key, tweak);
  return {
    publicKey: Uint8Array.of(0x02, ...schnorr.getPublicKey(tweaked)),
    sign: () => {
      throw new Error('ECDSA is not used for taproot');
    },
    signSchnorr: (hash: Uint8Array) => schnorr.sign(hash, tweaked, new Uint8Array(32)),
  };
}

/**
 * A p2wpkh spend signed with bitcoinjs-lib's own PSBT signer (independent of the driver):
 * `inputs` are `[txid, vout, value]` of outputs paying `key`'s p2wpkh script.
 */
export function signedSpend(
  key: Uint8Array,
  inputs: readonly (readonly [string, number, bigint])[],
  outputs: readonly (readonly [Uint8Array, bigint])[],
  sequence = 0xfffffffd,
): string {
  const signer = nativeSigner(key);
  const script = bitcoin.payments.p2wpkh({ pubkey: signer.publicKey })
    .output as Uint8Array;
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  for (const [txid, vout, value] of inputs) {
    psbt.addInput({ hash: txid, index: vout, sequence, witnessUtxo: { script, value } });
  }
  for (const [out, value] of outputs) psbt.addOutput({ script: out, value });
  psbt.signAllInputs(signer).finalizeAllInputs();
  return psbt.extractTransaction(true).toHex();
}

/** The ways a miner can change a p2pkh transaction without its key (consensus-valid). */
export type Malleation = 'high-s' | 'pushdata1' | 'junk-push' | 'op-nop';

/** A malleated copy of a p2pkh transaction: same effect, another txid. */
export function malleate(hex: string, kind: Malleation): string {
  const tx = bitcoin.Transaction.fromHex(hex);
  tx.ins.forEach((input, index) => {
    const [sig, key] = bitcoin.script.decompile(input.script) as [Uint8Array, Uint8Array];
    let script: Uint8Array;
    switch (kind) {
      case 'high-s': {
        const decoded = bitcoin.script.signature.decode(sig);
        const s = secp256k1.CURVE.n - bytesToNumberBE(decoded.signature.slice(32));
        const flipped = concatBytes(
          decoded.signature.slice(0, 32),
          numberToBytesBE(s, 32),
        );
        script = bitcoin.script.compile([
          bitcoin.script.signature.encode(flipped, decoded.hashType),
          key,
        ]);
        break;
      }
      case 'pushdata1':
        script = Uint8Array.of(0x4c, sig.length, ...sig, 0x4c, key.length, ...key);
        break;
      case 'junk-push':
        script = Uint8Array.of(0x02, 0x07, 0x07, ...input.script);
        break;
      case 'op-nop':
        script = Uint8Array.of(0x61, ...input.script);
        break;
    }
    tx.setInputScript(index, script);
  });
  return tx.toHex();
}

/** A p2pkh spend signed by bitcoinjs-lib: `inputs` are `[txid, vout, previous tx hex]`. */
export function signedLegacySpend(
  key: Uint8Array,
  inputs: readonly (readonly [string, number, string])[],
  outputs: readonly (readonly [Uint8Array, bigint])[],
): string {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  for (const [txid, vout, prev] of inputs) {
    psbt.addInput({
      hash: txid,
      index: vout,
      sequence: 0xfffffffd,
      nonWitnessUtxo: fromHex(prev),
    });
  }
  for (const [out, value] of outputs) psbt.addOutput({ script: out, value });
  psbt.signAllInputs(nativeSigner(key)).finalizeAllInputs();
  return psbt.extractTransaction(true).toHex();
}

// ---- hand-serialized transactions (bitcoinjs' decoder is quadratic) -------------------

export const u32 = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
export const compactSize = (n: number): Uint8Array =>
  n < 0xfd
    ? Uint8Array.of(n)
    : n <= 0xffff
      ? Uint8Array.of(0xfd, n & 0xff, n >> 8)
      : concatBytes(Uint8Array.of(0xfe), u32(n));
export const txidOfStripped = (stripped: Uint8Array): string =>
  toHex(sha256(sha256(stripped)).reverse());

/** A transaction serialized by hand: one input, `outputs` empty-script outputs of 1 sat. */
export function manyOutputs(outputs: number, witness = 0) {
  const input = concatBytes(
    new Uint8Array(32).fill(7),
    u32(0),
    compactSize(0),
    u32(0xffffffff),
  );
  const one = concatBytes(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), compactSize(0));
  const body = new Uint8Array(outputs * one.length);
  for (let i = 0; i < outputs; i++) body.set(one, i * one.length);
  const version = u32(2);
  const locktime = u32(0);
  const stripped = concatBytes(
    version,
    compactSize(1),
    input,
    compactSize(outputs),
    body,
    locktime,
  );
  if (witness === 0) return { bytes: stripped, stripped };
  const bytes = concatBytes(
    version,
    Uint8Array.of(0, 1),
    compactSize(1),
    input,
    compactSize(outputs),
    body,
    compactSize(1),
    compactSize(witness),
    new Uint8Array(witness),
    locktime,
  );
  return { bytes, stripped };
}
