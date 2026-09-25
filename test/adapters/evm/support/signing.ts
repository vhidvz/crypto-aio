import type { UnsignedTx } from '../../../../src/core/model/transaction';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import type { SignatureBundle, SigningContext } from '../../../../src/core/signing/types';
import { KEY } from './vectors';

const SIGNING_CONTEXT = {
  operationId: 'op',
  namespace: 'ns',
  chain: 'ethereum',
  network: 'sepolia',
  wallet: 'w',
  purpose: 'original',
  summary: { asset: 'x', outputs: [] },
  fee: { kind: 'evm-1559', speed: 'normal', charges: [], bound: 'upper', details: {} },
  unsignedHash: 'h',
} as SigningContext;

/** Signs an unsigned transaction with the test key through a real `localSigner`. */
export async function signWithKey(
  unsigned: UnsignedTx,
): Promise<readonly SignatureBundle[]> {
  const result = await localSigner({ secp256k1: secret(KEY) }).sign(
    unsigned.signingRequests,
    SIGNING_CONTEXT,
  );
  if (result.status !== 'signed') throw new Error('unreachable');
  return result.signatures;
}
