import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';

/** A local signer that counts how many times it was asked to sign. */
export function countingSigner(id = 'hot'): {
  signer: Signer;
  inner: Signer;
  calls: () => number;
} {
  const inner = localSigner.generate({ curves: ['secp256k1'], id }).signer;
  let calls = 0;
  const signer = callbackSigner({
    id,
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  });
  return { signer, inner, calls: () => calls };
}
