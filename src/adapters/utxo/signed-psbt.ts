/**
 * The reader of a PSBT signed elsewhere: a cold signer's or a coordinator's copy of our
 * PSBT is untrusted input. It is capped before decoding and parsed strictly. What could
 * change the spend is refused: another unsigned transaction, a changed previous output,
 * redeem script or internal key, an input script path, or a foreign, cross-scheme or
 * other-sighash signature. What cannot change it is ignored: key origins, the output
 * scripts a coordinator adds for change detection, proprietary keys and PSBT version 0.
 * Only signature bytes are taken, and the core verifies them against the stored requests.
 * Every refusal is `ValidationError('INVALID_INTENT')` with a fixed text. Synchronous and
 * I/O-free.
 */
import { ValidationError } from '../../core/errors/error';
import { equalBytes, toHex } from '../../core/util/bytes';
import { readTx } from './rawtx';
import { bitcoin, type Network, type Psbt } from './sdk';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_DEFAULT = 0x00;

export type PsbtInput = Psbt['data']['inputs'][number];

interface KeyValue {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export const signedPsbtError = (reason: string): ValidationError =>
  new ValidationError('INVALID_INTENT', `the signed PSBT ${reason}`);
const sighashError = (expected: 'SIGHASH_ALL' | 'SIGHASH_DEFAULT'): ValidationError =>
  signedPsbtError(`uses a sighash type other than ${expected}`);
const shapeError = (): ValidationError =>
  signedPsbtError('carries a final script of another shape');
const fieldError = (): ValidationError =>
  signedPsbtError('carries a field a signer does not add');
const changedError = (): ValidationError =>
  signedPsbtError('changes the prepared transaction');

/**
 * What a signer may add to each map of our PSBT (signatures, final scripts, a sighash type,
 * key origins, change-output scripts, proprietary keys): well under 1 KiB per input for one
 * key. A larger PSBT is not a signed copy of ours, and is refused before it is decoded.
 */
const SIGNED_GROWTH_PER_MAP = 4_096;
/**
 * Room for the previous transaction a coordinator may add to a non-taproot input of ours
 * that lacks one (`nonWitnessUtxo` off): a standard transaction's largest stripped size
 * (`MAX_STANDARD_TX_WEIGHT` / 4).
 */
const ADDED_PREVIOUS_TX = 100_000;
/**
 * What coordinators may add in all, whatever the number of inputs: one block (Bitcoin
 * Core's `MAX_BLOCK_SERIALIZED_SIZE`), so the decoding it costs stays bounded. Unbounded,
 * 160 inputs with `nonWitnessUtxo` off took 8 s of synchronous decoding.
 */
const ADDED_PREVIOUS_TXS = 4_000_000;

/** BIP174 key types a signed copy may carry but we never read. */
const PROPRIETARY = 0xfc;
const GLOBAL_VERSION = 0xfb;

/** Key origins (BIP32 derivations), which a signer or a coordinator may add. */
const KEY_ORIGINS = ['bip32Derivation', 'tapBip32Derivation'];
/**
 * The fields a signed copy of our PSBT may carry. `unknownKeyVals` holds every key bip174
 * does not know, and only proprietary keys (and, globally, version 0) may be among them.
 */
const SIGNED_GLOBAL_FIELDS: ReadonlySet<string> = new Set([
  'unsignedTx',
  'globalXpub',
  'unknownKeyVals',
]);
/**
 * Per input: signatures, final scripts, a sighash type, key origins, and our own fields
 * unchanged (or a verified previous transaction). The script-path fields (`witnessScript`,
 * `tapLeafScript`, `tapScriptSig`, `tapMerkleRoot`) and `porCommitment` are refused.
 */
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
  'unknownKeyVals',
]);
/**
 * Per output: key origins and the scripts Core's `UpdatePSBTOutput` adds so a hardware
 * wallet recognizes change. None is read: the outputs are fixed by the unsigned transaction.
 */
const SIGNED_OUTPUT_FIELDS: ReadonlySet<string> = new Set([
  ...KEY_ORIGINS,
  'redeemScript',
  'witnessScript',
  'tapInternalKey',
  'tapTree',
  'unknownKeyVals',
]);

/** Our taproot inputs carry their internal key (`buildTx`). */
const isTaproot = (stored: PsbtInput): boolean => stored.tapInternalKey !== undefined;

/** ASCII whitespace (C `isspace`), trimmed at both ends of a pasted or file-read PSBT. */
const ASCII_SPACE: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function trimAsciiSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.has(text.charCodeAt(start))) start++;
  while (end > start && ASCII_SPACE.has(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

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
 * The value of the global map's `PSBT_GLOBAL_UNSIGNED_TX` (key `0x00`) of PSBT bytes, read
 * without decoding it; `undefined` when the magic or the global map is malformed, or it has
 * no such key.
 */
function globalUnsignedTx(bytes: Uint8Array): Uint8Array | undefined {
  const magic = [0x70, 0x73, 0x62, 0x74, 0xff];
  if (!magic.every((byte, index) => bytes[index] === byte)) return undefined;
  let offset = 5;
  const length = (): number | undefined => {
    const first = bytes[offset];
    if (first === undefined) return undefined;
    const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    if (offset + 1 + width > bytes.length) return undefined;
    let value = width === 0 ? first : 0;
    for (let i = width; i >= 1; i--) value = value * 256 + (bytes[offset + i] as number);
    offset += 1 + width;
    return value;
  };
  for (;;) {
    const keyLength = length();
    if (keyLength === undefined || offset + keyLength > bytes.length) return undefined;
    if (keyLength === 0) return undefined; // the end of the global map: no unsigned tx
    const unsignedKey = keyLength === 1 && bytes[offset] === 0x00;
    offset += keyLength;
    const valueLength = length();
    if (valueLength === undefined || offset + valueLength > bytes.length)
      return undefined;
    if (unsignedKey) return bytes.subarray(offset, offset + valueLength);
    offset += valueLength;
  }
}

/**
 * Canonical base64 (the standard alphabet, padded), or `undefined`. Node's decoder is
 * linear and far faster than a pure-JS one (a few milliseconds for 4 million characters,
 * against about 300), but it skips what it cannot read, so the bytes count only when they
 * encode back to exactly `text`.
 */
function canonicalBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) return undefined;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * A PSBT signed elsewhere, parsed strictly: capped before decoding, ASCII
 * whitespace trimmed at the ends, canonical base64 (the SDK's decoder skips junk), and no
 * bytes after its maps.
 */
export function parseSigned(
  text: string,
  stored: Psbt,
  storedBase64: string,
  network: Network,
): Psbt {
  if (typeof text !== 'string') throw signedPsbtError('does not decode');
  const maps = 1 + stored.inputCount + stored.txOutputs.length;
  const added = stored.data.inputs.filter(
    (input) => input.nonWitnessUtxo === undefined && !isTaproot(input),
  ).length;
  const room =
    maps * SIGNED_GROWTH_PER_MAP +
    Math.min(added * ADDED_PREVIOUS_TX, ADDED_PREVIOUS_TXS);
  if (text.length > storedBase64.length + Math.ceil(room / 3) * 4) {
    throw signedPsbtError('is too large');
  }
  const bytes = canonicalBase64(trimAsciiSpace(text));
  if (!bytes) throw signedPsbtError('does not decode');
  // The unsigned transaction it carries must be ours byte for byte before bitcoinjs
  // decodes it (its decoder is quadratic in the inputs and outputs).
  const unsigned = globalUnsignedTx(bytes);
  if (!unsigned) throw signedPsbtError('does not decode');
  if (!equalBytes(unsigned, stored.data.globalMap.unsignedTx.toBuffer())) {
    throw signedPsbtError('is not the prepared transaction');
  }
  let signed: Psbt;
  try {
    signed = bitcoin.Psbt.fromBuffer(bytes, { network });
  } catch {
    throw signedPsbtError('does not decode');
  }
  if (!endsAfterMaps(bytes, 1 + signed.inputCount + signed.txOutputs.length)) {
    throw signedPsbtError('does not decode');
  }
  return signed;
}

/** Refuses any field outside `allowed`, and any unknown key but those we ignore. */
function assertOnly(
  fields: { readonly unknownKeyVals?: readonly KeyValue[] },
  allowed: ReadonlySet<string>,
  global: boolean,
): void {
  for (const name of Object.keys(fields)) {
    if (!allowed.has(name)) throw fieldError();
  }
  for (const { key, value } of fields.unknownKeyVals ?? []) {
    const versionZero =
      global &&
      key.length === 1 &&
      key[0] === GLOBAL_VERSION &&
      value.length === 4 &&
      value.every((byte) => byte === 0);
    if (key[0] !== PROPRIETARY && !versionZero) throw fieldError();
  }
}

/**
 * A previous transaction on a signed input (BIP174 `non_witness_utxo`): it must decode
 * strictly and hash to the outpoint's txid, which fixes every byte but the witness (Core
 * writes it without one), and pay the output our PSBT spends. A coordinator may add one to a
 * non-taproot input of ours that lacks it; taproot never carries one (BIP341 commits to
 * every amount). It is never read.
 */
function assertPreviousTx(
  bytes: Uint8Array,
  stored: PsbtInput,
  outpoint: { readonly txid: string; readonly vout: number },
): void {
  if (isTaproot(stored)) throw changedError();
  // Our own previous transaction, byte for byte, which `buildTx` checked: no decode.
  if (stored.nonWitnessUtxo !== undefined && equalBytes(bytes, stored.nonWitnessUtxo)) {
    return;
  }
  // Read in one linear pass, its txid hashed from the bytes (bitcoinjs' decoder is
  // quadratic), and capped at the million bytes without witness a chain can hold.
  const prev = readTx(bytes);
  if (!prev) throw signedPsbtError('does not decode');
  const output = prev.outputs[outpoint.vout];
  const ours = stored.witnessUtxo;
  if (
    prev.txid !== outpoint.txid ||
    !output ||
    (ours !== undefined &&
      (output.value !== ours.value || !equalBytes(output.script, ours.script)))
  ) {
    throw changedError();
  }
}

/**
 * Our fields a signed input carries unchanged, or not at all (a finalizer drops some): its
 * previous output, redeem script and taproot internal key; a previous transaction is checked
 * by its txid. A signed PSBT never decides an amount or a script.
 */
function assertUnchanged(
  signed: PsbtInput,
  stored: PsbtInput,
  outpoint: { readonly txid: string; readonly vout: number },
): void {
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
    a === undefined || (b !== undefined && equalBytes(a, b));
  const utxo = signed.witnessUtxo;
  if (
    !same(signed.redeemScript, stored.redeemScript) ||
    !same(signed.tapInternalKey, stored.tapInternalKey) ||
    (utxo !== undefined &&
      (stored.witnessUtxo === undefined ||
        utxo.value !== stored.witnessUtxo.value ||
        !equalBytes(utxo.script, stored.witnessUtxo.script)))
  ) {
    throw changedError();
  }
  if (signed.nonWitnessUtxo !== undefined) {
    assertPreviousTx(signed.nonWitnessUtxo, stored, outpoint);
  }
}

/**
 * Every field of a signed copy whose unsigned transaction is already ours: the global map,
 * each output and each input (see the allowlists and `assertUnchanged`).
 */
export function assertSignedFields(signed: Psbt, stored: Psbt): void {
  assertOnly(signed.data.globalMap, SIGNED_GLOBAL_FIELDS, true);
  for (const output of signed.data.outputs)
    assertOnly(output, SIGNED_OUTPUT_FIELDS, false);
  const outpoints = stored.txInputs.map((input) => ({
    txid: toHex(Uint8Array.from(input.hash).reverse()),
    vout: input.index,
  }));
  signed.data.inputs.forEach((input, index) => {
    assertOnly(input, SIGNED_INPUT_FIELDS, false);
    assertUnchanged(
      input,
      stored.data.inputs[index] as PsbtInput,
      outpoints[index] as { txid: string; vout: number },
    );
  });
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

/** p2tr: the key-path signature (BIP341, SIGHASH_DEFAULT, 64 bytes), partial or final. */
export function schnorrSignatureOf(input: PsbtInput): Uint8Array | undefined {
  if (input.partialSig) throw signedPsbtError('carries a signature of another scheme');
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
    if (signature.length !== 64) throw signedPsbtError('carries a malformed signature');
  }
  return found[0];
}

/**
 * ECDSA: the signature of `publicKey` (strict DER, SIGHASH_ALL, returned as 64-byte r‖s),
 * partial or final: `<sig> <key>` in the scriptSig for p2pkh; in the witness for segwit v0,
 * whose scriptSig is empty or, for p2sh-p2wpkh, the push of our redeem script.
 */
export function ecdsaSignatureOf(
  publicKey: Uint8Array,
  input: PsbtInput,
  stored: PsbtInput,
): Uint8Array | undefined {
  if (input.tapKeySig) throw signedPsbtError('carries a signature of another scheme');
  if (input.sighashType !== undefined && input.sighashType !== SIGHASH_ALL) {
    throw sighashError('SIGHASH_ALL');
  }
  const found: Uint8Array[] = [];
  for (const partial of input.partialSig ?? []) {
    if (!equalBytes(partial.pubkey, publicKey)) {
      throw signedPsbtError('carries a signature for another key');
    }
    found.push(partial.signature);
  }
  const ours = (stack: Uint8Array[] | undefined): Uint8Array => {
    if (stack?.length !== 2 || !equalBytes(stack[1] as Uint8Array, publicKey)) {
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
      throw signedPsbtError('carries a malformed signature');
    }
    if (decoded.hashType !== SIGHASH_ALL) throw sighashError('SIGHASH_ALL');
    return decoded.signature;
  });
  return signatures[0];
}
