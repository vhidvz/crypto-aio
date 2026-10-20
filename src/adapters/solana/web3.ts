/**
 * The only module that imports `@solana/web3.js`, for the `crypto-aio/native`
 * `Connection` alone: the driver builds messages and program-derived addresses itself
 * (`message.ts`), so it works the same with every supported SDK line (1.x and the
 * Kit-based 3.x). It is never on a driver request path: `Connection` retries HTTP 429 on
 * a real timer and would drop the call's tags, so the driver sends every request straight
 * to the transport, and the native `Connection` reaches the same transport through
 * `transport.createFetch`.
 */
import { Connection } from '@solana/web3.js';
import { PLACEHOLDER_ORIGIN, type Transport } from '../../core/transport/types';
import { solanaDriverFactory } from './driver';
import { associatedTokenAddress, compileLegacyMessage } from './message';
import { BROADCAST, READ } from './rpc';
import type { SolanaCodec } from './types';

/**
 * The tags of a native client's requests: broadcasts for its writes (a transaction send
 * and a faucet airdrop, neither safe to retry as a read), plain reads for the rest.
 */
function classify(_url: URL, init: RequestInit | undefined) {
  const body = typeof init?.body === 'string' ? init.body : '';
  return /"method"\s*:\s*"(?:sendTransaction|requestAirdrop)"/.test(body)
    ? BROADCAST
    : READ;
}

export function createWeb3Codec(transport: Transport): SolanaCodec {
  return {
    associatedTokenAddress,
    compileMessage: compileLegacyMessage,
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
          // Subscriptions have no transport bridge, so a socket client that was used only
          // ever fails against the placeholder host and retries on a timer. Turn retries
          // off (a flag: it does not cancel a retry already armed), cancel the armed one
          // (while it waits there is no socket, so `close()` alone does nothing), then
          // close the socket if there is one.
          const socket = (
            connection as unknown as {
              _rpcWebSocket?: {
                close(): void;
                setAutoReconnect(on: boolean): void;
                reconnect_timer_id?: ReturnType<typeof setTimeout>;
              };
            }
          )._rpcWebSocket;
          if (!socket) return;
          socket.setAutoReconnect(false);
          clearTimeout(socket.reconnect_timer_id);
          socket.close();
        },
      };
    },
  };
}

/** The `@solana/web3.js` adapter's driver factory; the manifest's `load()` returns it. */
export const web3DriverFactory = solanaDriverFactory(createWeb3Codec);
