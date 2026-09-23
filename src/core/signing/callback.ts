import { ConfigError } from '../errors/error';
import type { Signer } from './types';

export interface CallbackSignerOptions {
  readonly id: string;
  readonly schemes: readonly string[];
  readonly getPublicKey: Signer['getPublicKey'];
  readonly sign: Signer['sign'];
  readonly cancelRequest?: (ticket: string) => Promise<void>;
}

/** Base for remote, KMS, HSM and MPC signers: supply the three callbacks. */
export function callbackSigner(options: CallbackSignerOptions): Signer {
  if (!options.id)
    throw new ConfigError('CONFIG_INVALID', 'callbackSigner requires an id');
  if (options.schemes.length === 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `callbackSigner '${options.id}' must declare at least one scheme`,
    );
  }
  const cancel = options.cancelRequest;
  const signer: Signer = {
    id: options.id,
    schemes: Object.freeze([...options.schemes]),
    getPublicKey: (scheme, keyRef) => options.getPublicKey(scheme, keyRef),
    sign: (requests, ctx) => options.sign(requests, ctx),
    ...(cancel ? { cancelRequest: (ticket: string) => cancel(ticket) } : {}),
  };
  return Object.freeze(signer);
}
