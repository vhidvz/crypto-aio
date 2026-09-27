import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import type { TronRawData } from '../../../../src/adapters/tron/types';
import type { UnsignedTx } from '../../../../src/core/model/transaction';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import type { SignatureBundle, SigningContext } from '../../../../src/core/signing/types';
import { fromHex, toHex } from '../../../../src/core/util/bytes';
import { encodeRawData, encodeTransaction } from './protobuf';
import { KEY } from './vectors';

/** tronweb's signature layout: r ‖ s ‖ (recovery + 27), over the txID. */
export function signTxId(txId: string, key: string = KEY): string {
  const sig = secp256k1.sign(fromHex(txId), fromHex(key));
  return `${toHex(sig.toCompactRawBytes())}${(sig.recovery + 27).toString(16)}`;
}

/** Encodes, signs and wraps `raw` with the independent codec: the signed hex and txID. */
export function signedTransaction(
  raw: TronRawData,
  key: string = KEY,
): { readonly hex: string; readonly id: string } {
  const rawHex = encodeRawData(raw);
  const id = toHex(sha256(fromHex(rawHex)));
  return { hex: encodeTransaction(rawHex, [signTxId(id, key)]), id };
}

const SIGNING_CONTEXT = {
  operationId: 'op',
  namespace: 'ns',
  chain: 'tron',
  network: 'nile',
  wallet: 'w',
  purpose: 'original',
  summary: { asset: 'x', outputs: [] },
  fee: { kind: 'tron', speed: 'normal', charges: [], bound: 'upper', details: {} },
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
