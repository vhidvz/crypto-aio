import { ed25519 } from '@noble/curves/ed25519';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { ConfigError } from '../errors/error';
import type { SigningParams } from '../signing/types';
import { equalBytes } from '../util/bytes';
import { unknownName } from '../util/names';

export interface VerifyInput {
  readonly publicKey: Uint8Array;
  readonly payload: Uint8Array;
  readonly signature: Uint8Array;
  readonly recovery?: number;
  readonly params?: SigningParams;
}

export interface SignatureScheme {
  readonly id: string;
  readonly publicKeyLength: number;
  verify(input: VerifyInput): boolean;
}

function safely(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/** 32-byte digest, 64-byte compact low-s signature, recovery bit required and checked. */
export const secp256k1Ecdsa = Object.freeze<SignatureScheme>({
  id: 'secp256k1-ecdsa',
  publicKeyLength: 33,
  verify: ({ publicKey, payload, signature, recovery }) =>
    safely(() => {
      if (payload.length !== 32 || signature.length !== 64) return false;
      if (recovery !== 0 && recovery !== 1) return false;
      const sig = secp256k1.Signature.fromCompact(signature);
      if (!secp256k1.verify(signature, payload, publicKey, { lowS: true })) return false;
      const recovered = sig
        .addRecoveryBit(recovery)
        .recoverPublicKey(payload)
        .toRawBytes(true);
      return equalBytes(recovered, publicKey);
    }),
});

/** BIP340 over a 32-byte message; the request's public key is the (possibly tweaked) x-only key. */
export const secp256k1Schnorr = Object.freeze<SignatureScheme>({
  id: 'secp256k1-schnorr',
  publicKeyLength: 32,
  verify: ({ publicKey, payload, signature }) =>
    safely(() => payload.length === 32 && schnorr.verify(signature, payload, publicKey)),
});

/** RFC 8032 strict verification (zip215 disabled). */
export const ed25519Scheme = Object.freeze<SignatureScheme>({
  id: 'ed25519',
  publicKeyLength: 32,
  verify: ({ publicKey, payload, signature }) =>
    safely(() => ed25519.verify(signature, payload, publicKey, { zip215: false })),
});

/** Frozen, like each scheme in it. */
export const BUILTIN_SCHEMES: readonly SignatureScheme[] = Object.freeze([
  secp256k1Ecdsa,
  secp256k1Schnorr,
  ed25519Scheme,
]);

export class SchemeCatalog {
  readonly #schemes = new Map<string, SignatureScheme>();

  constructor(initial: readonly SignatureScheme[] = []) {
    for (const scheme of initial) this.register(scheme);
  }

  register(scheme: SignatureScheme): void {
    if (this.#schemes.has(scheme.id)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `signature scheme '${scheme.id}' is already registered`,
      );
    }
    this.#schemes.set(scheme.id, scheme);
  }

  has(id: string): boolean {
    return this.#schemes.has(id);
  }

  get(id: string): SignatureScheme {
    const scheme = this.#schemes.get(id);
    if (!scheme) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('signature scheme', this.#schemes.keys()),
      );
    }
    return scheme;
  }

  list(): SignatureScheme[] {
    return [...this.#schemes.values()];
  }

  clone(): SchemeCatalog {
    return new SchemeCatalog(this.list());
  }
}
