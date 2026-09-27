import type { SolanaInstruction } from '../../../../src/adapters/solana/types';
import { createWeb3Codec } from '../../../../src/adapters/solana/web3';
import { signedTransaction } from '../../../../src/adapters/solana/wire';
import { KEY, KEY_ADDRESS, sign } from './vectors';

/** The codec without a transport (its native client is never used here). */
export const codec = createWeb3Codec(undefined as never);

/** A transaction signed by the test key (or `key`), as base64 wire bytes. */
export function signedTx(
  blockhash: string,
  instructions: readonly SolanaInstruction[],
  options: { readonly payer?: string; readonly key?: string } = {},
): string {
  const message = codec.compileMessage(
    options.payer ?? KEY_ADDRESS,
    blockhash,
    instructions,
  );
  const raw = signedTransaction([sign(message, options.key ?? KEY)], message);
  return Buffer.from(raw).toString('base64');
}
