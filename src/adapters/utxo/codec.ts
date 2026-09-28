/**
 * The bitcoinjs-lib codec (spec §15): the unsigned transaction and its PSBT (BIP174), the
 * per-input signature hashes (legacy, BIP143 for segwit v0, BIP341 key path for taproot),
 * assembly of the signed transaction, and the signatures of a PSBT signed elsewhere. The
 * driver persists only the PSBT (base64) and plain data (R11), and re-parses it here.
 */
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { SigningError, ValidationError, isCryptoAioError } from '../../core/errors/error';
import type { SignatureBundle, SigningRequest } from '../../core/signing/types';
import { concatBytes, equalBytes, fromHex, toHex } from '../../core/util/bytes';
import { hash160, outputScript, type WalletAddress } from './address';
import type { PlannedOutput, Spendable } from './coinselect';
import { bitcoin, useNobleEcc, type Network, type Psbt, type Transaction } from './sdk';
import {
  SIGHASH_ALL,
  SIGHASH_DEFAULT,
  assertSignedFields,
  ecdsaSignatureOf,
  parseSigned,
  schnorrSignatureOf,
  signedPsbtError,
  type PsbtInput,
} from './signed-psbt';

/** The sighash types each input signs with (ALL; DEFAULT for p2tr), defined with the reader. */
export { SIGHASH_ALL, SIGHASH_DEFAULT } from './signed-psbt';

/** BIP125 opt-in (and relative lock time disabled); `0xfffffffe` when RBF is off. */
export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_FINAL_LOCKTIME = 0xfffffffe;

export interface PlannedInput extends Spendable {
  /**
   * The full previous transaction (BIP174 `non_witness_utxo`), txid-checked: required for
   * p2pkh, and added for segwit v0 so hardware wallets can check the input amounts (D12).
   * The PSBT carries it without its witness, as Bitcoin Core writes it.
   */
  readonly prevTxHex?: string;
}

export interface BuiltTx {
  /** The PSBT, base64 (spec §15: the signing payload a cold signer receives). */
  readonly psbt: string;
  /** One signature hash per input, in input order. */
  readonly digests: readonly Uint8Array[];
  /** The txid, when every input is witness-type (it is then fixed before signing). */
  readonly txid?: string;
}

/** Bitcoin Core's `MAX_MONEY` (21 million bitcoin): no amount is larger (lesson 19). */
const MAX_MONEY = 2_100_000_000_000_000n;
/** Bitcoin Core's `MAX_BLOCK_SERIALIZED_SIZE`: no transaction is larger (lesson 20). */
const MAX_TX_BYTES = 4_000_000;
const HEX = /^[0-9a-fA-F]*$/;
const TXID = /^[0-9a-f]{64}$/;

const isU32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const isMoney = (value: bigint): boolean =>
  typeof value === 'bigint' && value >= 0n && value <= MAX_MONEY;

/** Internal byte order of a txid (bitcoinjs `addInput` takes the reversed display hex). */
const txidBytes = (txid: string): Uint8Array => fromHex(txid).reverse();

/**
 * Untrusted transaction hex (a node's answer), decoded strictly: capped at the largest
 * possible transaction before decoding (lesson 20), plain hex only, and no bytes after the
 * transaction (bitcoinjs' own `fromHex` stops quietly at the first non-hex character).
 */
function decodeTxHex(hex: string): Transaction | undefined {
  if (typeof hex !== 'string' || hex.length > 2 * MAX_TX_BYTES) return undefined;
  if (hex.length % 2 !== 0 || !HEX.test(hex)) return undefined;
  try {
    return bitcoin.Transaction.fromBuffer(fromHex(hex));
  } catch {
    return undefined;
  }
}

/**
 * Lesson 19: every integer `buildTx` encodes fits its field, refused with a fixed text that
 * names no value (bitcoinjs' own check quotes it).
 */
function assertEncodable(
  inputs: readonly PlannedInput[],
  outputs: readonly PlannedOutput[],
  sequence: number,
): void {
  if (!isU32(sequence)) {
    throw new ValidationError('INVALID_INTENT', 'the input sequence is out of range');
  }
  const outpoints = new Set<string>();
  for (const input of inputs) {
    if (!TXID.test(input.txid) || !isU32(input.vout)) {
      throw new ValidationError('INVALID_INTENT', 'an input outpoint is out of range');
    }
    const outpoint = `${input.txid}:${input.vout}`;
    if (outpoints.has(outpoint)) {
      throw new ValidationError('INVALID_INTENT', 'an input outpoint is listed twice');
    }
    outpoints.add(outpoint);
    if (!isMoney(input.value)) {
      throw new ValidationError('INVALID_AMOUNT', 'an input value is out of range');
    }
  }
  for (const output of outputs) {
    if (!isMoney(output.value)) {
      throw new ValidationError('INVALID_AMOUNT', 'an output value is out of range');
    }
  }
}

const PREVIOUS_UNDECODABLE = 'a previous transaction does not decode';
const PREVIOUS_MISMATCH = 'a previous transaction does not match its outpoint';

/**
 * Whether `error` is `buildTx`'s refusal of an input's previous transaction (`prevTxHex`):
 * bytes that do not decode, or bytes whose output disagrees with the input's txid, value or
 * script. A caller that read those from a provider maps it to the provider.
 */
export function isPreviousTxRefusal(error: unknown): boolean {
  return (
    isCryptoAioError(error, 'INVALID_INTENT') &&
    (error.message === PREVIOUS_UNDECODABLE || error.message === PREVIOUS_MISMATCH)
  );
}

/**
 * Checks a previous transaction's bytes against the outpoint, value and script it funds,
 * and returns them without the witness for BIP174 `non_witness_utxo`: Bitcoin Core's form
 * (TX_NO_WITNESS), and smaller. The txid, which is all that authenticates them, is the same.
 */
function assertPrevious(
  prevTxHex: string,
  input: Spendable,
  script: Uint8Array,
): Uint8Array {
  const prev = decodeTxHex(prevTxHex);
  if (!prev) throw new ValidationError('INVALID_INTENT', PREVIOUS_UNDECODABLE);
  const output = prev.outs[input.vout];
  if (
    prev.getId() !== input.txid ||
    !output ||
    output.value !== input.value ||
    !equalBytes(output.script, script)
  ) {
    throw new ValidationError('INVALID_INTENT', PREVIOUS_MISMATCH);
  }
  const bare = prev.clone();
  bare.ins.forEach((_, index) => bare.setWitness(index, []));
  return bare.toBuffer();
}

/**
 * The unsigned transaction (version 2, lock time 0) and its PSBT, spending `inputs` of the
 * wallet to `outputs` in the given order.
 */
export function buildTx(
  network: Network,
  wallet: WalletAddress,
  inputs: readonly PlannedInput[],
  outputs: readonly PlannedOutput[],
  sequence: number,
): BuiltTx {
  assertEncodable(inputs, outputs, sequence);
  useNobleEcc();
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  for (const input of inputs) tx.addInput(txidBytes(input.txid), input.vout, sequence);
  for (const output of outputs) tx.addOutput(output.script, output.value);

  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  for (const input of inputs) {
    if (wallet.type === 'p2pkh' && input.prevTxHex === undefined) {
      throw new ValidationError(
        'INVALID_INTENT',
        'a p2pkh input needs its verified previous transaction',
      );
    }
    const prevTx =
      input.prevTxHex !== undefined
        ? assertPrevious(input.prevTxHex, input, wallet.script)
        : undefined;
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence,
      ...(wallet.type === 'p2pkh'
        ? {}
        : { witnessUtxo: { script: wallet.script, value: input.value } }),
      ...(prevTx !== undefined && wallet.type !== 'p2tr'
        ? { nonWitnessUtxo: prevTx }
        : {}),
      ...(wallet.redeemScript ? { redeemScript: wallet.redeemScript } : {}),
      ...(wallet.type === 'p2tr' ? { tapInternalKey: wallet.publicKey } : {}),
    });
  }
  for (const output of outputs)
    psbt.addOutput({ script: output.script, value: output.value });
  if (!equalBytes(unsignedTxOf(psbt), tx.toBuffer())) {
    throw new SigningError(
      'SIGNING_FAILED',
      'the PSBT does not encode the built transaction',
    );
  }

  const digests = inputs.map((input, index) => {
    switch (wallet.type) {
      case 'p2pkh':
        return tx.hashForSignature(index, wallet.script, SIGHASH_ALL);
      case 'p2wpkh':
      case 'p2sh-p2wpkh':
        // BIP143: the script code of a p2wpkh program is the p2pkh script of its key hash.
        return tx.hashForWitnessV0(
          index,
          outputScript('p2pkh', hash160(wallet.publicKey)),
          input.value,
          SIGHASH_ALL,
        );
      case 'p2tr':
        return tx.hashForWitnessV1(
          index,
          inputs.map(() => wallet.script),
          inputs.map((i) => i.value),
          SIGHASH_DEFAULT,
        );
    }
  });

  let txid: string | undefined;
  if (wallet.type !== 'p2pkh') {
    const final = tx.clone();
    if (wallet.redeemScript) {
      const scriptSig = bitcoin.script.compile([wallet.redeemScript]);
      for (let i = 0; i < inputs.length; i++) final.setInputScript(i, scriptSig);
    }
    txid = final.getId();
  }
  return { psbt: psbt.toBase64(), digests, ...(txid !== undefined ? { txid } : {}) };
}

/** The unsigned transaction a PSBT carries (BIP174 `PSBT_GLOBAL_UNSIGNED_TX`). */
export function unsignedTxOf(psbt: Psbt): Uint8Array {
  return psbt.data.globalMap.unsignedTx.toBuffer();
}

export function parsePsbt(base64: string, network: Network): Psbt {
  // Parsing reads taproot fields and output addresses, which need the ECC backend.
  useNobleEcc();
  try {
    return bitcoin.Psbt.fromBase64(base64, { network });
  } catch {
    throw new ValidationError('INVALID_INTENT', 'the payload is not a valid PSBT');
  }
}

export interface PsbtTxView {
  readonly inputs: readonly {
    readonly outpoint: string;
    readonly txid: string;
    readonly vout: number;
    readonly value: bigint;
    readonly sequence: number;
  }[];
  readonly outputs: readonly { readonly script: Uint8Array; readonly value: bigint }[];
}

/** Inputs (with the values the PSBT commits to) and outputs of our own stored PSBT. */
export function viewPsbt(base64: string, network: Network): PsbtTxView {
  const psbt = parsePsbt(base64, network);
  const inputs = psbt.txInputs.map((input, index) => {
    const data = psbt.data.inputs[index];
    const txid = toHex(Uint8Array.from(input.hash).reverse());
    let value: bigint;
    if (data?.witnessUtxo) value = data.witnessUtxo.value;
    else if (data?.nonWitnessUtxo) {
      let prev: Transaction | undefined;
      try {
        prev = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo);
      } catch {
        prev = undefined;
      }
      const output = prev?.getId() === txid ? prev.outs[input.index] : undefined;
      if (!output) {
        throw new ValidationError(
          'INVALID_INTENT',
          'a PSBT input does not match its previous transaction',
        );
      }
      value = output.value;
    } else throw new ValidationError('INVALID_INTENT', 'a PSBT input has no UTXO');
    return {
      outpoint: `${txid}:${input.index}`,
      txid,
      vout: input.index,
      value,
      sequence: input.sequence ?? 0xffffffff,
    };
  });
  const outputs = psbt.txOutputs.map((output) => ({
    script: output.script,
    value: output.value,
  }));
  return { inputs, outputs };
}

/**
 * The signed transaction from our stored PSBT and one signature per request (`in:<i>`):
 * ECDSA as a DER signature with SIGHASH_ALL (partial signature), Schnorr as a 64-byte
 * key-path signature. Nothing but the signature bytes comes from outside.
 */
export function assembleTx(
  base64: string,
  network: Network,
  requests: readonly SigningRequest[],
  signatures: readonly SignatureBundle[],
): { readonly hex: string; readonly txid: string } {
  const psbt = parsePsbt(base64, network);
  if (requests.length !== psbt.inputCount) {
    throw new SigningError('SIGNING_FAILED', 'one signing request per input is required');
  }
  requests.forEach((request, index) => {
    const signature = signatures.find((s) => s.requestId === request.id);
    if (!signature || signature.bytes.length !== 64) {
      throw new SigningError(
        'SIGNING_FAILED',
        `missing signature for request ${request.id}`,
      );
    }
    if (request.scheme === 'secp256k1-schnorr') {
      psbt.updateInput(index, { tapKeySig: signature.bytes });
    } else {
      psbt.updateInput(index, {
        partialSig: [
          {
            pubkey: request.publicKey,
            signature: bitcoin.script.signature.encode(signature.bytes, SIGHASH_ALL),
          },
        ],
      });
    }
  });
  try {
    psbt.finalizeAllInputs();
  } catch {
    throw new SigningError('SIGNING_FAILED', 'the PSBT could not be finalized');
  }
  // The absurd-fee guard ran when the transaction was built; bitcoinjs' own check is off.
  const tx = psbt.extractTransaction(true);
  return { hex: tx.toHex(), txid: tx.getId() };
}

/**
 * P3-B (A6): the signatures of a PSBT signed elsewhere, synchronous and I/O-free. The
 * signed PSBT is untrusted (`signed-psbt.ts`): parsed strictly, it must carry exactly our
 * unsigned transaction (anti-tamper) and nothing that could change the spend. From each
 * input only the signature for the request's key is taken (partial or final), and the core
 * then verifies it against the stored digest and key. An input without one is left out (a
 * partial set). Every refusal is `INVALID_INTENT` with a fixed text.
 */
export function signaturesFromPsbt(
  storedBase64: string,
  signedBase64: string,
  network: Network,
  requests: readonly SigningRequest[],
): SignatureBundle[] {
  const stored = parsePsbt(storedBase64, network);
  if (requests.length !== stored.inputCount) {
    throw new SigningError('SIGNING_FAILED', 'one signing request per input is required');
  }
  const signed = parseSigned(signedBase64, stored, storedBase64, network);
  if (!equalBytes(unsignedTxOf(signed), unsignedTxOf(stored))) {
    throw signedPsbtError('is not the prepared transaction');
  }
  assertSignedFields(signed, stored);
  const bundles: SignatureBundle[] = [];
  requests.forEach((request, index) => {
    const input = signed.data.inputs[index] as PsbtInput;
    if (request.scheme === 'secp256k1-schnorr') {
      const signature = schnorrSignatureOf(input);
      if (signature)
        bundles.push({ requestId: request.id, bytes: Uint8Array.from(signature) });
      return;
    }
    const ours = stored.data.inputs[index] as PsbtInput;
    const signature = ecdsaSignatureOf(request.publicKey, input, ours);
    if (signature) {
      bundles.push({
        requestId: request.id,
        bytes: Uint8Array.from(signature),
        recovery: recoveryOf(signature, request),
      });
    }
  });
  return bundles;
}

/** The recovery bit that recovers the request's key (0 when neither does: it then fails verification). */
function recoveryOf(signature: Uint8Array, request: SigningRequest): number {
  for (const bit of [0, 1]) {
    try {
      const key = secp256k1.Signature.fromCompact(signature)
        .addRecoveryBit(bit)
        .recoverPublicKey(request.payload)
        .toRawBytes(true);
      if (equalBytes(key, request.publicKey)) return bit;
    } catch {
      // Try the other bit.
    }
  }
  return 0;
}

/** bitcoinjs network parameters for a network's address parameters. */
export function networkOf(params: {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
}): Network {
  const base =
    params.bech32 === 'bc'
      ? bitcoin.networks.bitcoin
      : params.bech32 === 'bcrt'
        ? bitcoin.networks.regtest
        : bitcoin.networks.testnet;
  return {
    ...base,
    bech32: params.bech32,
    pubKeyHash: params.pubKeyHash,
    scriptHash: params.scriptHash,
  };
}

/**
 * The txid of raw transaction hex, decoded strictly (lesson 20); `INVALID_INTENT` when it
 * does not decode.
 */
export function txidOfHex(hex: string): string {
  const tx = decodeTxHex(hex);
  if (!tx) {
    throw new ValidationError('INVALID_INTENT', 'a transaction does not decode');
  }
  return tx.getId();
}

/**
 * C2: the txid `hex` would have with canonical p2pkh scriptSigs: per input, the last push that
 * is a strict-DER SIGHASH_ALL signature (normalized to low-s) and the last push that is a
 * 33-byte key hashing to `pubkeyHash`, re-pushed minimally as `<sig> <key>`. A third party
 * without the key can change only that encoding (BIP66 strict DER is consensus; the sighash
 * byte is signed), so this equals our Attempt's txid exactly when `hex` is a malleated copy
 * of it: same version, lock time, outpoints, sequences and outputs. `undefined` when an
 * input has a witness or no such pushes.
 */
export function canonicalTwinTxid(
  hex: string,
  pubkeyHash: Uint8Array,
): string | undefined {
  const tx = decodeTxHex(hex);
  if (!tx || tx.hasWitnesses()) return undefined;
  const half = secp256k1.CURVE.n >> 1n;
  for (let index = 0; index < tx.ins.length; index++) {
    const chunks = bitcoin.script.decompile(
      (tx.ins[index] as { script: Uint8Array }).script,
    );
    if (!chunks) return undefined;
    let signature: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    for (const chunk of chunks) {
      if (typeof chunk === 'number') continue;
      if (chunk.length === 33 && equalBytes(hash160(chunk), pubkeyHash)) key = chunk;
      try {
        const decoded = bitcoin.script.signature.decode(chunk);
        if (decoded.hashType === SIGHASH_ALL) signature = decoded.signature;
      } catch {
        // Not a signature push.
      }
    }
    if (!signature || !key) return undefined;
    const r = signature.slice(0, 32);
    let s = bytesToNumberBE(signature.slice(32));
    if (s > half) s = secp256k1.CURVE.n - s;
    const low = concatBytes(r, numberToBytesBE(s, 32));
    tx.setInputScript(
      index,
      bitcoin.script.compile([bitcoin.script.signature.encode(low, SIGHASH_ALL), key]),
    );
  }
  return tx.getId();
}
