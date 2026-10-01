/**
 * Address history from `getSignaturesForAddress`, newest first. The cursor is the
 * last signature of a page. A token account's history holds the SPL transfers into it; an
 * owner's history holds only the transactions that name the owner itself.
 */
import type { AddressHistorySource, DriverTransaction } from '../../core/driver/types';
import {
  ProviderError,
  ValidationError,
  type CryptoAioError,
} from '../../core/errors/error';
import { decodeTransaction } from './decode';
import { isSignature } from './keys';
import { readTransaction, type SolanaContext } from './reader';
import { READ, RPC_CODES, call, inconsistent, malformed, rpcCode } from './rpc';

/** `getSignaturesForAddress` returns at most this many signatures per call (agave). */
export const MAX_HISTORY_PAGE = 1_000;

export function createSolanaHistory(ctx: SolanaContext): AddressHistorySource {
  return {
    async list(address, { cursor, limit }) {
      if (cursor !== undefined && !isSignature(cursor)) {
        throw new ValidationError('INVALID_INTENT', 'not a Solana history cursor');
      }
      const size = Math.min(limit, MAX_HISTORY_PAGE);
      let result: unknown;
      try {
        result = await call(
          ctx.transport,
          'getSignaturesForAddress',
          [
            address,
            {
              limit: size,
              commitment: 'confirmed',
              ...(cursor !== undefined ? { before: cursor } : {}),
            },
          ],
          READ,
        );
      } catch (error) {
        // A backend that does not hold the cursor's transaction (another backend behind a
        // load balancer, or a pruned one) answers -32020. That decides nothing: another
        // backend may hold it.
        if (rpcCode(error) === RPC_CODES.FILTER_TRANSACTION_NOT_FOUND) {
          // The node's error stays reachable: its cause and where it happened.
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the endpoint does not know the history cursor',
            { cause: error, context: (error as CryptoAioError).context },
          );
        }
        throw error;
      }
      if (!Array.isArray(result)) throw malformed('getSignaturesForAddress');
      const signatures = result.map((entry: unknown) => {
        const signature = (entry as { signature?: unknown } | null)?.signature;
        if (!isSignature(signature)) throw malformed('getSignaturesForAddress');
        return signature;
      });
      const items: DriverTransaction[] = [];
      for (const signature of signatures) {
        const found = await readTransaction(ctx, signature, READ);
        if (!found) throw inconsistent('a listed transaction is missing');
        items.push(
          decodeTransaction(found.parsed, {
            height: found.header.blockHeight,
            hash: found.header.blockhash,
            ...(found.parsed.blockTime !== undefined
              ? { blockTime: found.parsed.blockTime }
              : {}),
          }),
        );
      }
      // Paged on the raw page: only a page shorter than asked ends the history, and one
      // longer than asked never does.
      const last = signatures[signatures.length - 1];
      return {
        items,
        ...(signatures.length >= size && last !== undefined ? { next: last } : {}),
      };
    },
  };
}
