import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import type { FakeEnv } from '../../../src/testing/env';

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

/** Mines one block per step while advancing fake time until `promise` settles. */
export async function mineWhile<T>(
  env: FakeEnv,
  promise: Promise<T>,
  stepMs = 1_000,
  maxSteps = 500,
): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < maxSteps && !done; i++) {
    env.chain.mine();
    await env.clock.advance(stepMs);
  }
  return tracked;
}
