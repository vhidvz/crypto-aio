/**
 * The script interpreter of the scripted Esplora node (test-only): bitcoind's `VerifyScript`,
 * `EvalScript`, `VerifyWitnessProgram` and `ExecuteWitnessScript` for the standard templates
 * (p2pkh, p2sh-p2wpkh, p2wpkh, p2wsh, p2tr key path, bare `OP_TRUE`), with bitcoinjs'
 * signature hashes and `@noble/curves`, and the script classification that standardness reads
 * (`Solver`, push-only, witness programs). Pure: a `Checker` carries the transaction being
 * verified and the flag set. An opcode or spend path outside this set throws.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bitcoin, type Transaction } from '../../../../src/adapters/utxo/sdk';
import { concatBytes, equalBytes, fromHex, toHex } from '../../../../src/core/util/bytes';

export const MAX_SCRIPT_SIZE = 10_000;
export const MAX_SCRIPT_ELEMENT_SIZE = 520;
const TRUE = Uint8Array.of(1);
const FALSE = new Uint8Array(0);

/** bitcoind's `ScriptErrorString` texts. */
const ERR = {
  EVAL_FALSE:
    'Script evaluated without error but finished with a false/empty top stack element',
  OP_RETURN: 'OP_RETURN was encountered',
  SCRIPT_SIZE: 'Script is too large',
  PUSH_SIZE: 'Push value size limit exceeded',
  BAD_OPCODE: 'Opcode missing or not understood',
  INVALID_STACK_OPERATION: 'Operation not valid with the current stack size',
  EQUALVERIFY: 'Script failed an OP_EQUALVERIFY operation',
  SIG_HASHTYPE: 'Signature hash type missing or not understood',
  SIG_DER: 'Non-canonical DER signature',
  MINIMALDATA: 'Data push larger than necessary',
  SIG_PUSHONLY: 'Only push operators allowed in signatures',
  SIG_HIGH_S: 'Non-canonical signature: S value is unnecessarily high',
  PUBKEYTYPE: 'Public key is neither compressed or uncompressed',
  CLEANSTACK: 'Stack size must be exactly one after execution',
  SIG_NULLFAIL: 'Signature must be zero for failed CHECK(MULTI)SIG operation',
  DISCOURAGE_UPGRADABLE_NOPS: 'NOPx reserved for soft-fork upgrades',
  DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM:
    'Witness version reserved for soft-fork upgrades',
  WITNESS_PROGRAM_WRONG_LENGTH: 'Witness program has incorrect length',
  WITNESS_PROGRAM_WITNESS_EMPTY: 'Witness program was passed an empty witness',
  WITNESS_PROGRAM_MISMATCH: 'Witness program hash mismatch',
  WITNESS_MALLEATED: 'Witness requires empty scriptSig',
  WITNESS_MALLEATED_P2SH: 'Witness requires only-redeemscript scriptSig',
  WITNESS_UNEXPECTED: 'Witness provided for non-witness script',
  WITNESS_PUBKEYTYPE: 'Using non-compressed keys in segwit',
  SCHNORR_SIG_SIZE: 'Invalid Schnorr signature size',
  SCHNORR_SIG_HASHTYPE: 'Invalid Schnorr signature hash type',
  SCHNORR_SIG: 'Invalid Schnorr signature',
} as const;

export interface Checker {
  readonly tx: Transaction;
  readonly index: number;
  readonly prevScripts: Uint8Array[];
  readonly prevValues: bigint[];
  /** Bitcoin Core's standard flags; `false`: the consensus (mandatory) flags only. */
  readonly policy: boolean;
}

export type SigVersion = 'base' | 'v0';

export class ScriptFailure extends Error {}
const fail = (reason: string): never => {
  throw new ScriptFailure(reason);
};

export const compactSizeLength = (n: number): number =>
  n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
const bigOf = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`);
const bytes32 = (n: bigint): Uint8Array => fromHex(n.toString(16).padStart(64, '0'));

export interface Op {
  readonly code: number;
  readonly data?: Uint8Array;
}

/** `GetOp` over a whole script; `undefined` when a push runs past its end. */
export function parseScript(script: Uint8Array): Op[] | undefined {
  const ops: Op[] = [];
  let i = 0;
  while (i < script.length) {
    const code = script[i++]!;
    let size = -1;
    if (code <= 0x4b) size = code;
    else if (code === 0x4c || code === 0x4d || code === 0x4e) {
      const width = code === 0x4c ? 1 : code === 0x4d ? 2 : 4;
      if (i + width > script.length) return undefined;
      size = 0;
      for (let k = width - 1; k >= 0; k--) size = size * 256 + script[i + k]!;
      i += width;
    }
    if (size < 0) {
      ops.push({ code });
      continue;
    }
    if (i + size > script.length) return undefined;
    ops.push({ code, data: script.subarray(i, i + size) });
    i += size;
  }
  return ops;
}

/** `IsPushOnly`: every opcode is a push or `OP_1NEGATE`..`OP_16`. */
export function isPushOnly(script: Uint8Array): boolean {
  const ops = parseScript(script);
  return ops !== undefined && ops.every((op) => op.code <= 0x60);
}

/** `HasValidOps`. */
export function hasValidOps(script: Uint8Array): boolean {
  const ops = parseScript(script);
  return (
    ops !== undefined &&
    ops.every(
      (op) => op.code <= 0xb9 && (op.data?.length ?? 0) <= MAX_SCRIPT_ELEMENT_SIZE,
    )
  );
}

/** `CheckMinimalPush`. */
export function minimalPush(op: Op): boolean {
  const data = op.data as Uint8Array;
  if (data.length === 0) return op.code === 0x00;
  if (data.length === 1 && data[0]! >= 1 && data[0]! <= 16) return false;
  if (data.length === 1 && data[0] === 0x81) return false;
  if (data.length <= 75) return op.code === data.length;
  if (data.length <= 255) return op.code === 0x4c;
  if (data.length <= 65_535) return op.code === 0x4d;
  return true;
}

/** `CScript() << data`. */
export function pushData(data: Uint8Array): Uint8Array {
  if (data.length < 0x4c) return concatBytes(Uint8Array.of(data.length), data);
  if (data.length <= 0xff) return concatBytes(Uint8Array.of(0x4c, data.length), data);
  return concatBytes(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
}

/** `CScript() << n` (BIP34 heights). */
export function pushNumber(n: number): Uint8Array {
  if (n === 0) return Uint8Array.of(0x00);
  if (n >= 1 && n <= 16) return Uint8Array.of(0x50 + n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.push(v % 256);
  if (bytes[bytes.length - 1]! & 0x80) bytes.push(0);
  return pushData(Uint8Array.from(bytes));
}

/** A push-only script's stack (`EvalScript` with no flags), or `undefined` on failure. */
export function pushStack(script: Uint8Array): Uint8Array[] | undefined {
  const ops = parseScript(script);
  if (!ops) return undefined;
  const stack: Uint8Array[] = [];
  for (const op of ops) {
    if (op.data !== undefined) {
      if (op.data.length > MAX_SCRIPT_ELEMENT_SIZE) return undefined;
      stack.push(op.data);
    } else if (op.code === 0x4f) stack.push(Uint8Array.of(0x81));
    else if (op.code >= 0x51 && op.code <= 0x60)
      stack.push(Uint8Array.of(op.code - 0x50));
    else return undefined;
  }
  return stack;
}

export function witnessProgram(
  script: Uint8Array,
): { readonly version: number; readonly program: Uint8Array } | undefined {
  if (script.length < 4 || script.length > 42) return undefined;
  const op = script[0]!;
  if (op !== 0x00 && (op < 0x51 || op > 0x60)) return undefined;
  if (script[1]! + 2 !== script.length) return undefined;
  return { version: op === 0 ? 0 : op - 0x50, program: script.subarray(2) };
}

export const isP2sh = (s: Uint8Array): boolean =>
  s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
export const isP2pkh = (s: Uint8Array): boolean =>
  s.length === 25 &&
  s[0] === 0x76 &&
  s[1] === 0xa9 &&
  s[2] === 0x14 &&
  s[23] === 0x88 &&
  s[24] === 0xac;
export const isPayToAnchor = (s: Uint8Array): boolean =>
  s.length === 4 && s[0] === 0x51 && s[1] === 0x02 && s[2] === 0x4e && s[3] === 0x73;
/** `CScript::IsUnspendable`: never enters the UTXO set. */
export const isUnspendable = (s: Uint8Array): boolean =>
  (s.length > 0 && s[0] === 0x6a) || s.length > MAX_SCRIPT_SIZE;

export type ScriptType =
  | 'p2pkh'
  | 'p2sh'
  | 'p2wpkh'
  | 'p2wsh'
  | 'p2tr'
  | 'anchor'
  | 'witness_unknown'
  | 'nulldata'
  | 'pubkey'
  | 'nonstandard';

/** bitcoind's `Solver`, without bare multisig (treated as non-standard: stricter). */
export function solve(s: Uint8Array): ScriptType {
  if (isP2sh(s)) return 'p2sh';
  const wp = witnessProgram(s);
  if (wp) {
    if (wp.version === 0 && wp.program.length === 20) return 'p2wpkh';
    if (wp.version === 0 && wp.program.length === 32) return 'p2wsh';
    if (wp.version === 1 && wp.program.length === 32) return 'p2tr';
    if (isPayToAnchor(s)) return 'anchor';
    return wp.version === 0 ? 'nonstandard' : 'witness_unknown';
  }
  if (s.length >= 1 && s[0] === 0x6a && isPushOnly(s.subarray(1))) return 'nulldata';
  if (
    s[s.length - 1] === 0xac &&
    ((s.length === 35 && s[0] === 33 && (s[1] === 2 || s[1] === 3)) ||
      (s.length === 67 && s[0] === 65 && s[1] === 4))
  )
    return 'pubkey';
  if (isP2pkh(s)) return 'p2pkh';
  return 'nonstandard';
}

export function castToBool(value: Uint8Array): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== 0) return !(i === value.length - 1 && value[i] === 0x80);
  }
  return false;
}

/** BIP66 `IsValidSignatureEncoding` (DER plus the sighash byte). */
export function isValidSignatureEncoding(sig: Uint8Array): boolean {
  if (sig.length < 9 || sig.length > 73) return false;
  if (sig[0] !== 0x30 || sig[1] !== sig.length - 3) return false;
  const lenR = sig[3]!;
  if (5 + lenR >= sig.length) return false;
  const lenS = sig[5 + lenR]!;
  if (lenR + lenS + 7 !== sig.length) return false;
  if (sig[2] !== 0x02 || lenR === 0 || sig[4]! & 0x80) return false;
  if (lenR > 1 && sig[4] === 0x00 && !(sig[5]! & 0x80)) return false;
  if (sig[lenR + 4] !== 0x02 || lenS === 0 || sig[lenR + 6]! & 0x80) return false;
  if (lenS > 1 && sig[lenR + 6] === 0x00 && !(sig[lenR + 7]! & 0x80)) return false;
  return true;
}

/** `r` and `s` of a signature that passed `isValidSignatureEncoding`. */
export function derValues(sig: Uint8Array): { r: bigint; s: bigint } {
  const lenR = sig[3]!;
  const lenS = sig[5 + lenR]!;
  return {
    r: bigOf(sig.subarray(4, 4 + lenR)),
    s: bigOf(sig.subarray(6 + lenR, 6 + lenR + lenS)),
  };
}

/** A public key as libsecp256k1 parses it (hybrid keys included), or `undefined`. */
export function parsePubkey(key: Uint8Array): Uint8Array | undefined {
  const header = key[0];
  if ((header === 2 || header === 3) && key.length === 33) return key;
  if (header === 4 && key.length === 65) return key;
  if ((header === 6 || header === 7) && key.length === 65) {
    if ((key[64]! & 1) !== (header & 1)) return undefined;
    return concatBytes(Uint8Array.of(4), key.subarray(1));
  }
  return undefined;
}

/** `EvalChecksigPreTapscript` and `CheckECDSASignature`. */
export function checksig(
  sig: Uint8Array,
  pubkey: Uint8Array,
  scriptCode: Uint8Array,
  sigversion: SigVersion,
  checker: Checker,
): boolean {
  const n = secp256k1.CURVE.n;
  if (sig.length > 0) {
    // DERSIG is a consensus rule (BIP66); LOW_S and STRICTENC are policy.
    if (!isValidSignatureEncoding(sig)) fail(ERR.SIG_DER);
    if (checker.policy) {
      const { r, s } = derValues(sig);
      if (r < n && s < n && s > n >> 1n) fail(ERR.SIG_HIGH_S);
      const type = sig[sig.length - 1]! & ~0x80;
      if (type < 1 || type > 3) fail(ERR.SIG_HASHTYPE);
    }
  }
  if (checker.policy) {
    const header = pubkey[0];
    const known =
      (pubkey.length === 33 && (header === 2 || header === 3)) ||
      (pubkey.length === 65 && header === 4);
    if (!known) fail(ERR.PUBKEYTYPE);
    if (sigversion === 'v0' && pubkey.length !== 33) fail(ERR.WITNESS_PUBKEYTYPE);
  }
  let ok = false;
  const key = parsePubkey(pubkey);
  if (key && sig.length > 0) {
    const hashType = sig[sig.length - 1]!;
    const { r, s } = derValues(sig);
    if (r > 0n && s > 0n && r < n && s < n) {
      const digest =
        sigversion === 'base'
          ? checker.tx.hashForSignature(checker.index, scriptCode, hashType)
          : checker.tx.hashForWitnessV0(
              checker.index,
              scriptCode,
              checker.prevValues[checker.index]!,
              hashType,
            );
      const low = s > n >> 1n ? n - s : s;
      ok = secp256k1.verify(concatBytes(bytes32(r), bytes32(low)), digest, key, {
        prehash: false,
        lowS: true,
        format: 'compact',
      });
    }
  }
  if (!ok && checker.policy && sig.length > 0) fail(ERR.SIG_NULLFAIL);
  return ok;
}

/** `EvalScript` for the opcodes of the standard templates; anything else throws. */
export function evalScript(
  stack: Uint8Array[],
  script: Uint8Array,
  sigversion: SigVersion,
  checker: Checker,
): void {
  if (script.length > MAX_SCRIPT_SIZE) fail(ERR.SCRIPT_SIZE);
  const ops = parseScript(script) ?? fail(ERR.BAD_OPCODE);
  const need = (count: number) => {
    if (stack.length < count) fail(ERR.INVALID_STACK_OPERATION);
  };
  for (const op of ops) {
    if (op.data !== undefined) {
      if (op.data.length > MAX_SCRIPT_ELEMENT_SIZE) fail(ERR.PUSH_SIZE);
      if (checker.policy && !minimalPush(op)) fail(ERR.MINIMALDATA);
      stack.push(op.data);
      continue;
    }
    const code = op.code;
    if (code === 0x4f) stack.push(Uint8Array.of(0x81));
    else if (code >= 0x51 && code <= 0x60) stack.push(Uint8Array.of(code - 0x50));
    else if (code === 0x61)
      continue; // OP_NOP
    else if (code === 0xb0 || (code >= 0xb3 && code <= 0xb9)) {
      if (checker.policy) fail(ERR.DISCOURAGE_UPGRADABLE_NOPS);
    } else if (code === 0x50) fail(ERR.BAD_OPCODE);
    else if (code === 0x6a) fail(ERR.OP_RETURN);
    else if (code === 0x76) {
      need(1);
      stack.push(stack[stack.length - 1]!);
    } else if (code === 0xa9) {
      need(1);
      stack.push(bitcoin.crypto.hash160(stack.pop()!));
    } else if (code === 0x87 || code === 0x88) {
      need(2);
      const equal = equalBytes(stack.pop()!, stack.pop()!);
      if (code === 0x88) {
        if (!equal) fail(ERR.EQUALVERIFY);
      } else stack.push(equal ? TRUE : FALSE);
    } else if (code === 0xac) {
      need(2);
      const pubkey = stack.pop()!;
      const sig = stack.pop()!;
      stack.push(checksig(sig, pubkey, script, sigversion, checker) ? TRUE : FALSE);
    } else {
      throw new Error(
        `the scripted node does not model opcode 0x${code.toString(16)}: extend it or use a standard script`,
      );
    }
  }
}

/** `ExecuteWitnessScript`: a witness script leaves exactly one true element. */
export function executeWitnessScript(
  stack: Uint8Array[],
  script: Uint8Array,
  checker: Checker,
): void {
  if (stack.some((item) => item.length > MAX_SCRIPT_ELEMENT_SIZE)) fail(ERR.PUSH_SIZE);
  evalScript(stack, script, 'v0', checker);
  if (stack.length !== 1) fail(ERR.CLEANSTACK);
  if (!castToBool(stack[0]!)) fail(ERR.EVAL_FALSE);
}

/** BIP341 key-path spending: `CheckSchnorrSignature`. */
export function checkTaprootKey(
  sig: Uint8Array,
  program: Uint8Array,
  checker: Checker,
  annex: Uint8Array | undefined,
): void {
  if (sig.length !== 64 && sig.length !== 65) fail(ERR.SCHNORR_SIG_SIZE);
  const hashType = sig.length === 65 ? sig[64]! : 0x00;
  if (sig.length === 65 && hashType === 0x00) fail(ERR.SCHNORR_SIG_HASHTYPE);
  const defined = hashType <= 0x03 || (hashType >= 0x81 && hashType <= 0x83);
  const single = (hashType & 0x03) === 0x03;
  if (!defined || (single && checker.index >= checker.tx.outs.length)) {
    fail(ERR.SCHNORR_SIG_HASHTYPE);
  }
  const digest = checker.tx.hashForWitnessV1(
    checker.index,
    checker.prevScripts,
    checker.prevValues,
    hashType,
    undefined,
    annex,
  );
  if (!schnorr.verify(sig.subarray(0, 64), digest, program)) fail(ERR.SCHNORR_SIG);
}

/** `VerifyWitnessProgram`. */
export function verifyWitnessProgram(
  witness: readonly Uint8Array[],
  version: number,
  program: Uint8Array,
  checker: Checker,
  p2sh: boolean,
): void {
  if (version === 0) {
    if (program.length === 32) {
      if (witness.length === 0) fail(ERR.WITNESS_PROGRAM_WITNESS_EMPTY);
      const script = witness[witness.length - 1]!;
      if (!equalBytes(sha256(script), program)) fail(ERR.WITNESS_PROGRAM_MISMATCH);
      return executeWitnessScript(witness.slice(0, -1), script, checker);
    }
    if (program.length === 20) {
      if (witness.length !== 2) fail(ERR.WITNESS_PROGRAM_MISMATCH);
      const script = concatBytes(
        Uint8Array.of(0x76, 0xa9, 0x14),
        program,
        Uint8Array.of(0x88, 0xac),
      );
      return executeWitnessScript([...witness], script, checker);
    }
    return fail(ERR.WITNESS_PROGRAM_WRONG_LENGTH);
  }
  if (version === 1 && program.length === 32 && !p2sh) {
    if (witness.length === 0) fail(ERR.WITNESS_PROGRAM_WITNESS_EMPTY);
    const stack = [...witness];
    const last = stack[stack.length - 1]!;
    const annex = stack.length >= 2 && last[0] === 0x50 ? stack.pop() : undefined;
    if (stack.length === 1) return checkTaprootKey(stack[0]!, program, checker, annex);
    throw new Error('the scripted node does not model taproot script-path spending');
  }
  const anchor = version === 1 && program.length === 2 && program[0] === 0x4e;
  if (!p2sh && anchor && program[1] === 0x73) return; // pay-to-anchor
  if (checker.policy) fail(ERR.DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM);
}

/** `VerifyScript` (P2SH, WITNESS and TAPROOT always on; CLEANSTACK with the policy flags). */
export function verifyScript(
  scriptSig: Uint8Array,
  scriptPubKey: Uint8Array,
  witness: readonly Uint8Array[],
  checker: Checker,
): void {
  let stack: Uint8Array[] = [];
  evalScript(stack, scriptSig, 'base', checker);
  const copy = [...stack];
  evalScript(stack, scriptPubKey, 'base', checker);
  if (stack.length === 0 || !castToBool(stack[stack.length - 1]!)) fail(ERR.EVAL_FALSE);
  let hadWitness = false;
  const wp = witnessProgram(scriptPubKey);
  if (wp) {
    hadWitness = true;
    if (scriptSig.length !== 0) fail(ERR.WITNESS_MALLEATED);
    verifyWitnessProgram(witness, wp.version, wp.program, checker, false);
    stack = stack.slice(0, 1);
  }
  if (isP2sh(scriptPubKey)) {
    if (!isPushOnly(scriptSig)) fail(ERR.SIG_PUSHONLY);
    stack = copy;
    const redeem = stack.pop()!;
    evalScript(stack, redeem, 'base', checker);
    if (stack.length === 0 || !castToBool(stack[stack.length - 1]!)) fail(ERR.EVAL_FALSE);
    const inner = witnessProgram(redeem);
    if (inner) {
      hadWitness = true;
      if (!equalBytes(scriptSig, pushData(redeem))) fail(ERR.WITNESS_MALLEATED_P2SH);
      verifyWitnessProgram(witness, inner.version, inner.program, checker, true);
      stack = stack.slice(0, 1);
    }
  }
  if (checker.policy && stack.length !== 1) fail(ERR.CLEANSTACK);
  if (!hadWitness && witness.length > 0) fail(ERR.WITNESS_UNEXPECTED);
}
