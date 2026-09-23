import { mod } from '@noble/curves/abstract/modular';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { ConfigError, SigningError } from '../errors/error';
import { reveal, secret, type Secret } from '../secret/secret';
import { equalBytes, fromHex } from '../util/bytes';
import { deriveEd25519, deriveSecp256k1, mnemonicToSeed } from './hd';
import type {
  KeyRef,
  SignatureBundle,
  Signer,
  SigningContext,
  SigningRequest,
  SigningResult,
} from './types';

export type Curve = 'secp256k1' | 'ed25519';
export type KeySource = (curve: Curve, keyRef: KeyRef | undefined) => Uint8Array;

const SCHEME_CURVE: Readonly<Record<string, Curve>> = {
  'secp256k1-ecdsa': 'secp256k1',
  'secp256k1-schnorr': 'secp256k1',
  ed25519: 'ed25519',
};
const CURVE_SCHEMES: Readonly<Record<Curve, readonly string[]>> = {
  secp256k1: ['secp256k1-ecdsa', 'secp256k1-schnorr'],
  ed25519: ['ed25519'],
};

export function curveOfScheme(scheme: string): Curve | undefined {
  return SCHEME_CURVE[scheme];
}

/** In-process signer. Keys live only in private fields and are never serialized. */
export class LocalSigner implements Signer {
  readonly id: string;
  readonly schemes: readonly string[];
  readonly #keys: KeySource;
  readonly #exportable: boolean;

  constructor(
    id: string,
    curves: readonly Curve[],
    keys: KeySource,
    exportable: boolean,
  ) {
    this.id = id;
    this.schemes = curves.flatMap((curve) => CURVE_SCHEMES[curve]);
    this.#keys = keys;
    this.#exportable = exportable;
  }

  async getPublicKey(scheme: string, keyRef?: KeyRef): Promise<Uint8Array> {
    return publicKeyFor(scheme, this.#key(scheme, keyRef));
  }

  async sign(
    requests: readonly SigningRequest[],
    _ctx: SigningContext,
  ): Promise<SigningResult> {
    const signatures: SignatureBundle[] = requests.map((request) =>
      signOne(request, this.#key(request.scheme, request.keyRef)),
    );
    return { status: 'signed', signatures };
  }

  async exportKey(scheme: string, keyRef?: KeyRef): Promise<Secret<Uint8Array>> {
    if (!this.#exportable) {
      throw new SigningError(
        'KEY_NOT_EXPORTABLE',
        `signer '${this.id}' was not created as exportable`,
      );
    }
    return secret(Uint8Array.from(this.#key(scheme, keyRef)));
  }

  toJSON(): { id: string; schemes: readonly string[] } {
    return { id: this.id, schemes: this.schemes };
  }

  #key(scheme: string, keyRef: KeyRef | undefined): Uint8Array {
    const curve = SCHEME_CURVE[scheme];
    if (!curve || !this.schemes.includes(scheme)) {
      throw new SigningError(
        'SIGNER_UNAVAILABLE',
        `signer '${this.id}' does not support scheme '${scheme}'`,
      );
    }
    return this.#keys(curve, keyRef);
  }
}

function publicKeyFor(scheme: string, key: Uint8Array): Uint8Array {
  if (scheme === 'secp256k1-ecdsa') return secp256k1.getPublicKey(key, true);
  if (scheme === 'secp256k1-schnorr') return schnorr.getPublicKey(key);
  return ed25519.getPublicKey(key);
}

function assertOwnKey(request: SigningRequest, publicKey: Uint8Array): void {
  if (!equalBytes(request.publicKey, publicKey)) {
    throw new SigningError(
      'SIGNING_FAILED',
      `request '${request.id}': public key does not belong to this signer`,
    );
  }
}

function assertDigest(request: SigningRequest): void {
  if (request.payload.length !== 32) {
    throw new SigningError(
      'SIGNING_FAILED',
      `request '${request.id}': ${request.scheme} signs 32-byte digests`,
    );
  }
}

function signOne(request: SigningRequest, key: Uint8Array): SignatureBundle {
  if (request.scheme === 'secp256k1-ecdsa') {
    assertOwnKey(request, secp256k1.getPublicKey(key, true));
    assertDigest(request);
    const signature = secp256k1.sign(request.payload, key, { lowS: true });
    return {
      requestId: request.id,
      bytes: signature.toCompactRawBytes(),
      recovery: signature.recovery,
    };
  }
  if (request.scheme === 'secp256k1-schnorr') {
    const signingKey = request.params?.tweak
      ? tweakPrivateKey(key, request.params.tweak)
      : key;
    assertOwnKey(request, schnorr.getPublicKey(signingKey));
    assertDigest(request);
    return { requestId: request.id, bytes: schnorr.sign(request.payload, signingKey) };
  }
  assertOwnKey(request, ed25519.getPublicKey(key));
  return { requestId: request.id, bytes: ed25519.sign(request.payload, key) };
}

/** BIP341 key-path tweak: negate for odd Y, then add the tweak modulo n. */
export function tweakPrivateKey(key: Uint8Array, tweak: Uint8Array): Uint8Array {
  const n = secp256k1.CURVE.n;
  const t = bytesToNumberBE(tweak);
  if (tweak.length !== 32 || t >= n)
    throw new SigningError('SIGNING_FAILED', 'invalid taproot tweak');
  let d = bytesToNumberBE(key);
  if (!secp256k1.ProjectivePoint.fromPrivateKey(key).hasEvenY()) d = n - d;
  const tweaked = mod(d + t, n);
  if (tweaked === 0n) throw new SigningError('SIGNING_FAILED', 'tweaked key is zero');
  return numberToBytesBE(tweaked, 32);
}

function parseKey(input: Secret<string | Uint8Array>, curve: Curve): Uint8Array {
  const raw = reveal(input);
  let bytes: Uint8Array;
  try {
    bytes = typeof raw === 'string' ? fromHex(raw.trim()) : Uint8Array.from(raw);
  } catch {
    throw new ConfigError('CONFIG_INVALID', `${curve} private key is not valid hex`);
  }
  if (bytes.length !== 32)
    throw new ConfigError('CONFIG_INVALID', `${curve} private key must be 32 bytes`);
  if (curve === 'secp256k1' && !secp256k1.utils.isValidPrivateKey(bytes)) {
    throw new ConfigError('CONFIG_INVALID', 'secp256k1 private key is out of range');
  }
  return bytes;
}

export interface LocalSignerOptions {
  readonly id?: string;
  readonly secp256k1?: Secret<string | Uint8Array>;
  readonly ed25519?: Secret<string | Uint8Array>;
  readonly exportable?: boolean;
}

export interface GenerateOptions {
  readonly id?: string;
  readonly curves: readonly Curve[];
  readonly exportable?: boolean;
}

export interface GeneratedSigner {
  readonly signer: Signer;
  /** secp256k1: 33-byte compressed; ed25519: 32 bytes. */
  readonly publicKeys: Readonly<Partial<Record<Curve, Uint8Array>>>;
}

function fromKeys(
  id: string,
  keys: Partial<Record<Curve, Uint8Array>>,
  exportable: boolean,
): LocalSigner {
  const curves = (['secp256k1', 'ed25519'] as const).filter((curve) => keys[curve]);
  if (curves.length === 0)
    throw new ConfigError('CONFIG_INVALID', 'localSigner needs at least one key');
  return new LocalSigner(
    id,
    curves,
    (curve) => {
      const key = keys[curve];
      if (!key)
        throw new SigningError(
          'SIGNER_UNAVAILABLE',
          `signer '${id}' holds no ${curve} key`,
        );
      return key;
    },
    exportable,
  );
}

export function localSigner(options: LocalSignerOptions): Signer {
  const keys: Partial<Record<Curve, Uint8Array>> = {};
  if (options.secp256k1) keys.secp256k1 = parseKey(options.secp256k1, 'secp256k1');
  if (options.ed25519) keys.ed25519 = parseKey(options.ed25519, 'ed25519');
  return fromKeys(options.id ?? 'local', keys, options.exportable ?? false);
}

localSigner.generate = function generate(options: GenerateOptions): GeneratedSigner {
  const keys: Partial<Record<Curve, Uint8Array>> = {};
  const publicKeys: Partial<Record<Curve, Uint8Array>> = {};
  for (const curve of options.curves) {
    if (curve === 'secp256k1') {
      keys.secp256k1 = secp256k1.utils.randomPrivateKey();
      publicKeys.secp256k1 = secp256k1.getPublicKey(keys.secp256k1, true);
    } else {
      keys.ed25519 = ed25519.utils.randomPrivateKey();
      publicKeys.ed25519 = ed25519.getPublicKey(keys.ed25519);
    }
  }
  return {
    signer: fromKeys(options.id ?? 'local', keys, options.exportable ?? false),
    publicKeys,
  };
};

export interface MnemonicSignerOptions {
  readonly id?: string;
  readonly passphrase?: Secret<string>;
  readonly exportable?: boolean;
  readonly curves?: readonly Curve[];
}

/** BIP39 mnemonic signer; keys are derived per request from `keyRef.path` and cached in memory. */
localSigner.fromMnemonic = function fromMnemonic(
  phrase: Secret<string>,
  options: MnemonicSignerOptions = {},
): Signer {
  const seed = mnemonicToSeed(
    reveal(phrase),
    options.passphrase ? reveal(options.passphrase) : '',
  );
  const cache = new Map<string, Uint8Array>();
  const source: KeySource = (curve, keyRef) => {
    const path = keyRef?.path;
    if (!path) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'mnemonic signers need keyRef.path (set keyRef on the wallet)',
      );
    }
    const cacheKey = `${curve}:${path}`;
    let key = cache.get(cacheKey);
    if (!key) {
      key =
        curve === 'secp256k1' ? deriveSecp256k1(seed, path) : deriveEd25519(seed, path);
      cache.set(cacheKey, key);
    }
    return key;
  };
  return new LocalSigner(
    options.id ?? 'mnemonic',
    options.curves ?? ['secp256k1', 'ed25519'],
    source,
    options.exportable ?? false,
  );
};
