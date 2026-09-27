/**
 * Bitcoin addresses and output scripts, SDK-free (`@scure/base`, `@noble/*`), so the codec
 * is an implementation independent of bitcoinjs-lib, which the tests cross-check it against
 * (lesson 11). Decoding is strict (lesson 4): one network's HRP and base58 version bytes,
 * bech32 only for witness v0 and bech32m only for v1 (BIP350), exact program lengths, no
 * mixed case, and a taproot output key must be a valid x coordinate. Every failure is
 * `ValidationError('INVALID_ADDRESS')` with a message that names no address.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { ValidationError } from '../../core/errors/error';
import { concatBytes } from '../../core/util/bytes';
import type { AddressParams, UtxoAddressType, UtxoOutputType } from './types';

export type { AddressParams } from './types';

export interface DecodedAddress {
  readonly type: UtxoOutputType;
  /** Lowercase bech32, or the base58 string as given. */
  readonly canonical: string;
  readonly script: Uint8Array;
}

const base58check = createBase58check(sha256);
const BECH32_MAX = 90;

const invalid = (reason: string): never => {
  throw new ValidationError('INVALID_ADDRESS', `invalid Bitcoin address: ${reason}`);
};

export const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

/** The standard output script of each type. */
export function outputScript(type: UtxoOutputType, program: Uint8Array): Uint8Array {
  switch (type) {
    case 'p2pkh':
      return concatBytes(
        Uint8Array.of(0x76, 0xa9, 0x14),
        program,
        Uint8Array.of(0x88, 0xac),
      );
    case 'p2sh':
      return concatBytes(Uint8Array.of(0xa9, 0x14), program, Uint8Array.of(0x87));
    case 'p2wpkh':
      return concatBytes(Uint8Array.of(0x00, 0x14), program);
    case 'p2wsh':
      return concatBytes(Uint8Array.of(0x00, 0x20), program);
    case 'p2tr':
      return concatBytes(Uint8Array.of(0x51, 0x20), program);
  }
}

/** Whether 32 bytes are the x coordinate of a curve point (BIP340 `lift_x`). */
export function isXOnlyPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  try {
    schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(bytes));
    return true;
  } catch {
    return false;
  }
}

function decodeSegwit(address: string, params: AddressParams): DecodedAddress {
  if (address.length > BECH32_MAX) invalid('too long');
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    invalid('mixed case');
  }
  const lower = address.toLowerCase();
  let decoded: { prefix: string; words: number[] } | undefined;
  let variant: 'bech32' | 'bech32m' | undefined;
  try {
    decoded = bech32.decode(lower as `${string}1${string}`, BECH32_MAX);
    variant = 'bech32';
  } catch {
    try {
      decoded = bech32m.decode(lower as `${string}1${string}`, BECH32_MAX);
      variant = 'bech32m';
    } catch {
      invalid('bad checksum or encoding');
    }
  }
  const { prefix, words } = decoded as { prefix: string; words: number[] };
  if (prefix !== params.bech32) invalid('it belongs to another network');
  const version = words[0];
  if (version === undefined || version > 16) invalid('bad witness version');
  let program: Uint8Array = new Uint8Array();
  try {
    program = bech32.fromWords(words.slice(1));
  } catch {
    invalid('bad witness program padding');
  }
  if (version === 0) {
    if (variant !== 'bech32') invalid('witness v0 must use bech32');
    if (program.length === 20)
      return {
        type: 'p2wpkh',
        canonical: lower,
        script: outputScript('p2wpkh', program),
      };
    if (program.length === 32)
      return { type: 'p2wsh', canonical: lower, script: outputScript('p2wsh', program) };
    return invalid('bad witness v0 program length');
  }
  if (variant !== 'bech32m') invalid('witness v1+ must use bech32m');
  if (version === 1 && program.length === 32) {
    if (!isXOnlyPoint(program)) invalid('taproot output key is not on the curve');
    return { type: 'p2tr', canonical: lower, script: outputScript('p2tr', program) };
  }
  return invalid('unsupported witness version or program');
}

/** Decodes an address of this network; throws `INVALID_ADDRESS`. */
export function decodeAddress(address: string, params: AddressParams): DecodedAddress {
  if (typeof address !== 'string' || address.length === 0) invalid('empty');
  if (!/^[0-9A-Za-z]+$/.test(address)) invalid('unexpected characters');
  if (address.toLowerCase().startsWith(`${params.bech32}1`)) {
    return decodeSegwit(address, params);
  }
  let payload: Uint8Array = new Uint8Array();
  try {
    payload = base58check.decode(address);
  } catch {
    // A segwit address of another network lands here too.
    invalid('bad checksum or encoding');
  }
  if (payload.length !== 21) invalid('bad payload length');
  const version = payload[0];
  const hash = payload.slice(1);
  if (version === params.pubKeyHash)
    return { type: 'p2pkh', canonical: address, script: outputScript('p2pkh', hash) };
  if (version === params.scriptHash)
    return { type: 'p2sh', canonical: address, script: outputScript('p2sh', hash) };
  return invalid('it belongs to another network');
}

/**
 * R58: accepts only a 33-byte compressed key on the curve; a 32-byte x-only key only for
 * `p2tr` (a Schnorr-only signer's key). Never a private key, never an uncompressed key.
 */
function compressedKey(publicKey: Uint8Array, type: UtxoAddressType): Uint8Array {
  if (publicKey.length === 32 && type === 'p2tr') {
    if (!isXOnlyPoint(publicKey)) invalid('the x-only public key is not on the curve');
    return concatBytes(Uint8Array.of(0x02), publicKey);
  }
  if (publicKey.length !== 33 || (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) {
    invalid('a public key must be 33-byte compressed');
  }
  try {
    secp256k1.ProjectivePoint.fromHex(publicKey).assertValidity();
  } catch {
    invalid('the public key is not on the curve');
  }
  return publicKey;
}

/** BIP341/BIP86 key-path tweak of an internal key with no script tree. */
export function taprootTweak(internalKey: Uint8Array): {
  readonly tweak: Uint8Array;
  readonly outputKey: Uint8Array;
} {
  const point = schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(internalKey));
  const tweak = schnorr.utils.taggedHash('TapTweak', internalKey);
  const t = schnorr.utils.bytesToNumberBE(tweak);
  if (t >= secp256k1.CURVE.n) invalid('the taproot tweak is out of range');
  const output = point.add(secp256k1.ProjectivePoint.BASE.multiply(t));
  if (output.equals(secp256k1.ProjectivePoint.ZERO))
    invalid('the taproot output key is infinity');
  return { tweak, outputKey: output.toRawBytes(true).slice(1) };
}

export interface WalletAddress {
  readonly address: string;
  readonly type: UtxoAddressType;
  readonly script: Uint8Array;
  /** The key the wallet signs with: compressed (ECDSA) or x-only internal key (p2tr). */
  readonly publicKey: Uint8Array;
  /** p2sh-p2wpkh: the redeem script pushed in the scriptSig. */
  readonly redeemScript?: Uint8Array;
  /** p2tr: the BIP341 tweak and the tweaked output key the signature verifies against. */
  readonly tweak?: Uint8Array;
  readonly outputKey?: Uint8Array;
}

/** The wallet address of `type` for this public key (spec §15 address types). */
export function walletAddress(
  publicKey: Uint8Array,
  type: UtxoAddressType,
  params: AddressParams,
): WalletAddress {
  const key = compressedKey(publicKey, type);
  switch (type) {
    case 'p2wpkh': {
      const program = hash160(key);
      return {
        address: bech32.encode(params.bech32, [0, ...bech32.toWords(program)]),
        type,
        script: outputScript('p2wpkh', program),
        publicKey: key,
      };
    }
    case 'p2sh-p2wpkh': {
      const redeemScript = outputScript('p2wpkh', hash160(key));
      const hash = hash160(redeemScript);
      return {
        address: base58check.encode(concatBytes(Uint8Array.of(params.scriptHash), hash)),
        type,
        script: outputScript('p2sh', hash),
        publicKey: key,
        redeemScript,
      };
    }
    case 'p2pkh': {
      const hash = hash160(key);
      return {
        address: base58check.encode(concatBytes(Uint8Array.of(params.pubKeyHash), hash)),
        type,
        script: outputScript('p2pkh', hash),
        publicKey: key,
      };
    }
    case 'p2tr': {
      const internalKey = key.slice(1);
      const { tweak, outputKey } = taprootTweak(internalKey);
      return {
        address: bech32m.encode(params.bech32, [1, ...bech32m.toWords(outputKey)]),
        type,
        script: outputScript('p2tr', outputKey),
        publicKey: internalKey,
        tweak,
        outputKey,
      };
    }
  }
}

/** The wallet address type a sending address implies (a p2sh wallet is p2sh-p2wpkh). */
export function walletTypeOf(decoded: DecodedAddress): UtxoAddressType {
  switch (decoded.type) {
    case 'p2wpkh':
      return 'p2wpkh';
    case 'p2sh':
      return 'p2sh-p2wpkh';
    case 'p2pkh':
      return 'p2pkh';
    case 'p2tr':
      return 'p2tr';
    case 'p2wsh':
      throw new ValidationError(
        'INVALID_INTENT',
        'p2wsh (script) wallets cannot send; use p2wpkh, p2sh-p2wpkh, p2pkh or p2tr',
      );
  }
}

/** Bitcoin Core's `GetDustThreshold` (policy.cpp) at `dustRelayFee` sat/kvB, rounded up. */
export function dustThreshold(script: Uint8Array, dustRelayFee: bigint): bigint {
  const size = BigInt(8 + 1 + script.length);
  return ((size + (isWitnessProgram(script) ? 67n : 148n)) * dustRelayFee + 999n) / 1000n;
}

/** Bitcoin Core's `IsWitnessProgram`: a version opcode, then one push of 2 to 40 bytes. */
function isWitnessProgram(script: Uint8Array): boolean {
  const version = script[0];
  if (script.length < 4 || script.length > 42 || version === undefined) return false;
  if (version !== 0x00 && (version < 0x51 || version > 0x60)) return false;
  return script[1] === script.length - 2;
}
