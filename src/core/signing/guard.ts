import {
  SigningError,
  TimeoutError,
  isCryptoAioError,
  type CodesOf,
  type CryptoAioError,
  type ErrorContext,
} from '../errors/error';
import { sanitizeError } from '../secret/redact';
import type { Clock } from '../util/clock';
import type { KeyRef, Signer } from './types';

/** How long a signer may take to hand out a public key (`lifecycle.signTimeoutMs`). */
export interface SignerDeadline {
  readonly clock: Clock;
  readonly timeoutMs: number;
}

/*
 * Guards for every call into signer code (local, callback, KMS, HSM, MPC or user-written).
 * Custody backends put URLs and credentials in their error messages, so a failure that is
 * not already a CryptoAioError only ever surfaces as a sanitized cause. Never call a
 * `Signer` around these guards: a direct call can leak a custodian's message.
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

/**
 * The signer's public key for `scheme`, checked against `length` and copied. With a
 * `deadline`, a signer that does not answer in time fails with a retryable TIMEOUT
 * (its late answer is ignored), so a hung custody backend can never block its caller.
 */
export async function signerPublicKey(
  signerId: string,
  signer: Signer,
  scheme: string,
  keyRef: KeyRef | undefined,
  length: number,
  deadline?: SignerDeadline,
): Promise<Uint8Array> {
  let key: unknown;
  try {
    const asked = Promise.resolve(signer.getPublicKey(scheme, keyRef));
    key = deadline ? await withinDeadline(asked, deadline, signerId) : await asked;
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

/** `work`, or a retryable TIMEOUT once `deadline.timeoutMs` passes first. */
async function withinDeadline<T>(
  work: Promise<T>,
  deadline: SignerDeadline,
  signerId: string,
): Promise<T> {
  const done = new AbortController();
  // A late rejection must not surface as an unhandled one.
  work.catch(() => undefined);
  const expired = deadline.clock.sleep(deadline.timeoutMs, done.signal).then(() => {
    throw new TimeoutError(
      'TIMEOUT',
      `signer '${signerId}' did not provide its public key within lifecycle.signTimeoutMs`,
      { retryable: true },
    );
  });
  expired.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    done.abort();
  }
}
