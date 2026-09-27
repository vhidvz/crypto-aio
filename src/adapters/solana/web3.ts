/**
 * The only module that imports `@solana/web3.js` (spec §15): program-derived addresses,
 * legacy message compilation and the `crypto-aio/native` `Connection`. It is never on a
 * driver request path (lesson 1): the driver sends every request straight to the
 * transport, and the native `Connection` reaches the same transport through
 * `transport.createFetch` (spec §11).
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { PLACEHOLDER_ORIGIN, type Transport } from '../../core/transport/types';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM } from './programs';
import { BROADCAST, READ } from './rpc';
import type { SolanaCodec } from './types';

const TOKEN = new PublicKey(TOKEN_PROGRAM);
const ASSOCIATED_TOKEN = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

/** The tags of a native client's requests: plain reads, and broadcasts for sends. */
function classify(_url: URL, init: RequestInit | undefined) {
  const body = typeof init?.body === 'string' ? init.body : '';
  return /"method"\s*:\s*"sendTransaction"/.test(body) ? BROADCAST : READ;
}

export function createWeb3Codec(transport: Transport): SolanaCodec {
  return {
    associatedTokenAddress(owner, mint) {
      const [address] = PublicKey.findProgramAddressSync(
        [
          new PublicKey(owner).toBuffer(),
          TOKEN.toBuffer(),
          new PublicKey(mint).toBuffer(),
        ],
        ASSOCIATED_TOKEN,
      );
      return address.toBase58();
    },
    compileMessage(payer, recentBlockhash, instructions) {
      const message = new TransactionMessage({
        payerKey: new PublicKey(payer),
        recentBlockhash,
        instructions: instructions.map(
          (ix) =>
            new TransactionInstruction({
              programId: new PublicKey(ix.programId),
              keys: ix.accounts.map((a) => ({
                pubkey: new PublicKey(a.address),
                isSigner: a.signer,
                isWritable: a.writable,
              })),
              data: Buffer.from(ix.data),
            }),
        ),
      }).compileToLegacyMessage();
      return new Uint8Array(message.serialize());
    },
    createNative() {
      const connection = new Connection(`${PLACEHOLDER_ORIGIN}/`, {
        commitment: 'confirmed',
        fetch: transport.createFetch(classify),
        httpAgent: false,
        disableRetryOnRateLimit: true,
      });
      return {
        client: connection,
        close: () => {
          // Subscriptions have no transport bridge; close the idle socket client if used.
          // It retries a failed connection on a timer, so stop that first: a close while
          // a retry is pending would otherwise find no socket and leave the timer running.
          const socket = (
            connection as unknown as {
              _rpcWebSocket?: { close(): void; setAutoReconnect(on: boolean): void };
            }
          )._rpcWebSocket;
          socket?.setAutoReconnect(false);
          socket?.close();
        },
      };
    },
  };
}
