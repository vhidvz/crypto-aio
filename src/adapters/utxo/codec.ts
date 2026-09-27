/**
 * The bitcoinjs-lib codec (spec §15): the unsigned transaction and its PSBT (BIP174), the
 * per-input signature hashes (legacy, BIP143 for segwit v0, BIP341 key path for taproot),
 * assembly of the signed transaction, and the signatures of a PSBT signed elsewhere. The
 * driver persists only the PSBT (base64) and plain data (R11), and re-parses it here.
 */
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import { SigningError, ValidationError } from '../../core/errors/error';
import type { SignatureBundle, SigningRequest } from '../../core/signing/types';
import { concatBytes, equalBytes, fromHex, toHex } from '../../core/util/bytes';
import { hash160, outputScript, type WalletAddress } from './address';
import type { PlannedOutput, Spendable } from './coinselect';
import { bitcoin, useNobleEcc, type Network, type Psbt, type Transaction } from './sdk';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_DEFAULT = 0x00;
/** BIP125 opt-in (and relative lock time disabled); `0xfffffffe` when RBF is off. */
export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_FINAL_LOCKTIME = 0xfffffffe;

export interface PlannedInput extends Spendable {
  /**
   * The full previous transaction (BIP174 `non_witness_utxo`), txid-checked: required for
   * p2pkh, and added for segwit v0 so hardware wallets can check the input amounts (D12).
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
function decodeTxHex(hex: string): { bytes: Uint8Array; tx: Transaction } | undefined {
  if (typeof hex !== 'string' || hex.length > 2 * MAX_TX_BYTES) return undefined;
  if (hex.length % 2 !== 0 || !HEX.test(hex)) return undefined;
  const bytes = fromHex(hex);
  try {
    return { bytes, tx: bitcoin.Transaction.fromBuffer(bytes) };
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
  for (const input of inputs) {
    if (!TXID.test(input.txid) || !isU32(input.vout)) {
      throw new ValidationError('INVALID_INTENT', 'an input outpoint is out of range');
    }
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

/**
 * Checks a previous transaction's bytes against the outpoint, value and script it funds,
 * and returns them (BIP174 `non_witness_utxo`).
 */
function assertPrevious(
  prevTxHex: string,
  input: Spendable,
  script: Uint8Array,
): Uint8Array {
  const decoded = decodeTxHex(prevTxHex);
  if (!decoded) {
    throw new ValidationError('INVALID_INTENT', 'a previous transaction does not decode');
  }
  const prev = decoded.tx;
  const output = prev.outs[input.vout];
  if (
    prev.getId() !== input.txid ||
    !output ||
    output.value !== input.value ||
    !equalBytes(output.script, script)
  ) {
    throw new ValidationError(
      'INVALID_INTENT',
      'a previous transaction does not match its outpoint',
    );
  }
  return decoded.bytes;
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

/** Pushes of a script, or `undefined` when it is not push-only. */
function pushes(script: Uint8Array): Uint8Array[] | undefined {
  const chunks = bitcoin.script.decompile(script);
  if (!chunks || chunks.some((c) => typeof c === 'number')) return undefined;
  return chunks as Uint8Array[];
}

/** A serialized witness stack (BIP144): a count, then length-prefixed items. */
function witnessItems(witness: Uint8Array): Uint8Array[] | undefined {
  let offset = 0;
  const varint = (): number | undefined => {
    const first = witness[offset];
    if (first === undefined || first >= 0xfd) return undefined; // no item this long here
    offset += 1;
    return first;
  };
  const count = varint();
  if (count === undefined) return undefined;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = varint();
    if (length === undefined || offset + length > witness.length) return undefined;
    items.push(witness.slice(offset, offset + length));
    offset += length;
  }
  return offset === witness.length ? items : undefined;
}

const intentError = (reason: string): ValidationError =>
  new ValidationError('INVALID_INTENT', `the signed PSBT ${reason}`);
const sighashError = (expected: 'SIGHASH_ALL' | 'SIGHASH_DEFAULT'): ValidationError =>
  intentError(`uses a sighash type other than ${expected}`);
const shapeError = (): ValidationError =>
  intentError('carries a final script of another shape');

/**
 * What a signer may add to each map of our PSBT (signatures, final scripts, a sighash type,
 * key origins): well under 1 KiB per input for one key. A larger PSBT is not a signed copy
 * of ours, and is refused before it is decoded (lesson 20).
 */
const SIGNED_GROWTH_PER_MAP = 4_096;

type PsbtInput = Psbt['data']['inputs'][number];

/** Key origins (BIP32 derivations), which a signer or a coordinator may add. */
const KEY_ORIGINS = ['bip32Derivation', 'tapBip32Derivation'];
/**
 * The fields a signed copy of our PSBT may carry: the unsigned transaction and global
 * xpubs; per input, signatures, final scripts, a sighash type, key origins, and our own
 * fields unchanged; per output, key origins. Anything else, and every key bip174 does not
 * know (`unknownKeyVals`), is refused.
 */
const SIGNED_GLOBAL_FIELDS: ReadonlySet<string> = new Set(['unsignedTx', 'globalXpub']);
const SIGNED_INPUT_FIELDS: ReadonlySet<string> = new Set([
  ...KEY_ORIGINS,
  'partialSig',
  'tapKeySig',
  'finalScriptSig',
  'finalScriptWitness',
  'sighashType',
  'witnessUtxo',
  'nonWitnessUtxo',
  'redeemScript',
  'tapInternalKey',
]);
const SIGNED_OUTPUT_FIELDS: ReadonlySet<string> = new Set(KEY_ORIGINS);

/**
 * Whether PSBT bytes end right after their maps (BIP174: the global map, then one per input
 * and one per output), with every key and value length a minimal CompactSize inside the
 * bytes. bip174 ignores whatever follows the last map.
 */
function endsAfterMaps(bytes: Uint8Array, maps: number): boolean {
  let offset = 5; // the magic `psbt` and 0xff, which the parser has checked
  const length = (): number | undefined => {
    const first = bytes[offset];
    if (first === undefined) return undefined;
    const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    if (offset + 1 + width > bytes.length) return undefined;
    let value = width === 0 ? first : 0;
    for (let i = width; i >= 1; i--) value = value * 256 + (bytes[offset + i] as number);
    offset += 1 + width;
    const least = width === 0 ? 0 : width === 2 ? 0xfd : width === 4 ? 0x1_0000 : 2 ** 32;
    return value < least ? undefined : value;
  };
  for (let map = 0; map < maps; map++) {
    for (;;) {
      const keyLength = length();
      if (keyLength === undefined) return false;
      if (keyLength === 0) break;
      offset += keyLength;
      const valueLength = length();
      if (valueLength === undefined) return false;
      offset += valueLength;
    }
  }
  return offset === bytes.length;
}

/**
 * A PSBT signed elsewhere, parsed strictly: capped before decoding (lesson 20), canonical
 * base64 (the SDK's decoder skips junk), and no bytes after its maps.
 */
function parseSigned(
  text: string,
  stored: Psbt,
  storedBase64: string,
  network: Network,
): Psbt {
  const maps = 1 + stored.inputCount + stored.txOutputs.length;
  const limit = storedBase64.length + Math.ceil((maps * SIGNED_GROWTH_PER_MAP) / 3) * 4;
  if (typeof text !== 'string') throw intentError('does not decode');
  if (text.length > limit) throw intentError('is too large');
  let bytes: Uint8Array;
  let signed: Psbt;
  try {
    bytes = base64.decode(text);
    signed = bitcoin.Psbt.fromBuffer(bytes, { network });
  } catch {
    throw intentError('does not decode');
  }
  if (!endsAfterMaps(bytes, 1 + signed.inputCount + signed.txOutputs.length)) {
    throw intentError('does not decode');
  }
  return signed;
}

function assertOnly(fields: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw intentError('carries a field a signer does not add');
  }
}

/**
 * Our fields a signed input carries unchanged, or not at all (a finalizer drops some): its
 * previous output, previous transaction, redeem script and taproot internal key. A signed
 * PSBT never decides an amount or a script.
 */
function assertUnchanged(signed: PsbtInput, stored: PsbtInput): void {
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
    a === undefined || (b !== undefined && equalBytes(a, b));
  const utxo = signed.witnessUtxo;
  if (
    !same(signed.nonWitnessUtxo, stored.nonWitnessUtxo) ||
    !same(signed.redeemScript, stored.redeemScript) ||
    !same(signed.tapInternalKey, stored.tapInternalKey) ||
    (utxo !== undefined &&
      (stored.witnessUtxo === undefined ||
        utxo.value !== stored.witnessUtxo.value ||
        !equalBytes(utxo.script, stored.witnessUtxo.script)))
  ) {
    throw intentError('changes the prepared transaction');
  }
}

/** p2tr: the key-path signature (BIP341, SIGHASH_DEFAULT, 64 bytes), partial or final. */
function schnorrSignatureOf(input: PsbtInput): Uint8Array | undefined {
  if (input.partialSig) throw intentError('carries a signature of another scheme');
  if (input.sighashType !== undefined && input.sighashType !== SIGHASH_DEFAULT) {
    throw sighashError('SIGHASH_DEFAULT');
  }
  if (input.finalScriptSig !== undefined && input.finalScriptSig.length > 0) {
    throw shapeError();
  }
  const found: Uint8Array[] = [];
  if (input.tapKeySig) found.push(input.tapKeySig);
  if (input.finalScriptWitness) {
    const items = witnessItems(input.finalScriptWitness);
    if (items?.length !== 1) throw shapeError();
    found.push(items[0] as Uint8Array);
  }
  for (const signature of found) {
    if (signature.length === 65) throw sighashError('SIGHASH_DEFAULT');
    if (signature.length !== 64) throw intentError('carries a malformed signature');
  }
  return found[0];
}

/**
 * ECDSA: the request key's signature (strict DER, SIGHASH_ALL), partial or final: `<sig>
 * <key>` in the scriptSig for p2pkh; in the witness for segwit v0, whose scriptSig is empty
 * or, for p2sh-p2wpkh, the push of our redeem script.
 */
function ecdsaSignatureOf(
  request: SigningRequest,
  input: PsbtInput,
  stored: PsbtInput,
): Uint8Array | undefined {
  if (input.tapKeySig) throw intentError('carries a signature of another scheme');
  if (input.sighashType !== undefined && input.sighashType !== SIGHASH_ALL) {
    throw sighashError('SIGHASH_ALL');
  }
  const found: Uint8Array[] = [];
  for (const partial of input.partialSig ?? []) {
    if (!equalBytes(partial.pubkey, request.publicKey)) {
      throw intentError('carries a signature for another key');
    }
    found.push(partial.signature);
  }
  const ours = (stack: Uint8Array[] | undefined): Uint8Array => {
    if (stack?.length !== 2 || !equalBytes(stack[1] as Uint8Array, request.publicKey)) {
      throw shapeError();
    }
    return stack[0] as Uint8Array;
  };
  if (stored.witnessUtxo === undefined) {
    if (input.finalScriptWitness !== undefined) throw shapeError();
    if (input.finalScriptSig !== undefined)
      found.push(ours(pushes(input.finalScriptSig)));
  } else {
    const scriptSig = stored.redeemScript
      ? bitcoin.script.compile([stored.redeemScript])
      : new Uint8Array();
    if (
      input.finalScriptSig !== undefined &&
      !equalBytes(input.finalScriptSig, scriptSig)
    ) {
      throw shapeError();
    }
    if (input.finalScriptWitness !== undefined) {
      found.push(ours(witnessItems(input.finalScriptWitness)));
    }
  }
  const signatures = found.map((der) => {
    let decoded: { signature: Uint8Array; hashType: number };
    try {
      decoded = bitcoin.script.signature.decode(der);
    } catch {
      throw intentError('carries a malformed signature');
    }
    if (decoded.hashType !== SIGHASH_ALL) throw sighashError('SIGHASH_ALL');
    return decoded.signature;
  });
  return signatures[0];
}

/**
 * P3-B (A6): the signatures of a PSBT signed elsewhere, synchronous and I/O-free. The
 * signed PSBT is untrusted: it is parsed strictly, must carry exactly our unsigned
 * transaction (anti-tamper) and our own fields unchanged, and may add only signatures,
 * final scripts, the sighash type each input signs with and key origins. From each input
 * only the signature for the request's key is taken (partial or final), and the core then
 * verifies it against the stored digest and key. An input without one is left out (a
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
    throw intentError('is not the prepared transaction');
  }
  assertOnly(signed.data.globalMap, SIGNED_GLOBAL_FIELDS);
  for (const output of signed.data.outputs) assertOnly(output, SIGNED_OUTPUT_FIELDS);
  const bundles: SignatureBundle[] = [];
  requests.forEach((request, index) => {
    const input = signed.data.inputs[index] as PsbtInput;
    const ours = stored.data.inputs[index] as PsbtInput;
    assertOnly(input, SIGNED_INPUT_FIELDS);
    assertUnchanged(input, ours);
    if (request.scheme === 'secp256k1-schnorr') {
      const signature = schnorrSignatureOf(input);
      if (signature)
        bundles.push({ requestId: request.id, bytes: Uint8Array.from(signature) });
      return;
    }
    const signature = ecdsaSignatureOf(request, input, ours);
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
  const decoded = decodeTxHex(hex);
  if (!decoded) {
    throw new ValidationError('INVALID_INTENT', 'a transaction does not decode');
  }
  return decoded.tx.getId();
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
  const tx = decodeTxHex(hex)?.tx;
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
