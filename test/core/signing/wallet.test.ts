import { secp256k1 } from '@noble/curves/secp256k1';
import type { ResolvedSelection } from '../../../src/core/config/types';
import type { ChainDriver } from '../../../src/core/driver/types';
import { secret } from '../../../src/core/secret/secret';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import { resolveWallet } from '../../../src/core/signing/wallet';
import { toHex } from '../../../src/core/util/bytes';

const hot = localSigner({
  id: 'hot',
  secp256k1: secret(secp256k1.utils.randomPrivateKey()),
});
const cold = localSigner({
  id: 'cold',
  secp256k1: secret(secp256k1.utils.randomPrivateKey()),
});

/** Just enough of a driver for `resolveWallet`: the address is the key's hex. */
const driver = {
  address: {
    validate: () => true,
    normalize: (address: string) => ({ canonical: address, display: address }),
    fromPublicKey: (publicKey: Uint8Array) => ({
      canonical: toHex(publicKey),
      display: toHex(publicKey),
    }),
  },
} as unknown as ChainDriver;

function selection(signer: Signer): ResolvedSelection {
  return {
    chain: { id: 'c', schemes: ['secp256k1-ecdsa'] },
    wallet: { name: 'w', config: { signer: signer.id, signers: { vault: 'cold' } } },
    signer: { id: signer.id, instance: signer },
  } as unknown as ResolvedSelection;
}

describe('resolveWallet', () => {
  it('signerById finds the primary and configured signers by own key only', async () => {
    const wallet = await resolveWallet(selection(hot), driver, { hot, cold });
    expect(wallet.signerById('hot')).toEqual({ id: 'hot', signer: hot });
    expect(wallet.signerById('cold')).toEqual({ id: 'cold', signer: cold });
    expect(wallet.signerById('missing')).toBeUndefined();
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(wallet.signerById(inherited)).toBeUndefined();
    }
  });
});
