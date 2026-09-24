import {
  SigningError,
  isCryptoAioError,
  type CodesOf,
  type CryptoAioError,
  type ErrorContext,
} from '../errors/error';
import { sanitizeError } from '../secret/redact';
import type { KeyRef, Signer } from './types';

/*
 * Guards for every call into signer code (local, callback, KMS, HSM, MPC or user-written).
 * Custody backends put URLs and credentials in their error messages, so a failure that is
 * not already a CryptoAioError only ever surfaces as a sanitized cause (ruling R9).
 */

/** A CryptoAioError passes through; anything else becomes `code` with a sanitized cause. */
export function signerFailure(
  error: unknown,
  code: CodesOf<'signing'>,
  message: string,
  context?: ErrorContext,
): CryptoAioError {
  if (isCryptoAioError(error)) return error;
  return new SigningError(code, message, {
    cause: sanitizeError(error),
    ...(context ? { context } : {}),
  });
}

/** The signer's declared schemes, read once and copied; SIGNER_UNAVAILABLE if unusable. */
export function signerSchemes(
  signerId: string,
  signer: Signer,
  context?: ErrorContext,
): readonly string[] {
  try {
    const schemes: unknown = signer.schemes;
    if (Array.isArray(schemes) && schemes.every((s) => typeof s === 'string')) {
      return [...(schemes as string[])];
    }
  } catch (error) {
    throw signerFailure(
      error,
      'SIGNER_UNAVAILABLE',
      `signer '${signerId}' has an unreadable scheme list`,
      context,
    );
  }
  throw new SigningError(
    'SIGNER_UNAVAILABLE',
    `signer '${signerId}' does not declare a list of schemes`,
    context ? { context } : {},
  );
}

/** R9.3: the signer's public key for `scheme`, checked against `length` and copied. */
export async function signerPublicKey(
  signerId: string,
  signer: Signer,
  scheme: string,
  keyRef: KeyRef | undefined,
  length: number,
): Promise<Uint8Array> {
  let key: unknown;
  try {
    key = await signer.getPublicKey(scheme, keyRef);
  } catch (error) {
    throw signerFailure(
      error,
      'SIGNER_UNAVAILABLE',
      `signer '${signerId}' could not provide its ${scheme} public key`,
    );
  }
  const copy = key instanceof Uint8Array ? new Uint8Array(key) : undefined;
  if (!copy || copy.length !== length) {
    throw new SigningError(
      'SIGNER_UNAVAILABLE',
      `signer '${signerId}' returned a malformed ${scheme} public key (expected ${length} bytes)`,
    );
  }
  return copy;
}
