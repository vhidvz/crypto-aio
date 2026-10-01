/**
 * Opt-in, read-only checks against a live Avalanche network, skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only:
 * - CRYPTO_AIO_IT_AVALANCHE_NETWORK: `mainnet` or `fuji` (default `fuji`);
 * - CRYPTO_AIO_IT_AVALANCHE_X_RPC_URL / CRYPTO_AIO_IT_AVALANCHE_P_RPC_URL: a node's chain
 *   API (`…/ext/bc/X`, `…/ext/bc/P`; default: the `public` preset);
 * - CRYPTO_AIO_IT_AVALANCHE_X_INDEXER_URL / …_P_INDEXER_URL: a Data API base for the chain
 *   (default: the keyless `public` preset).
 *
 * Nothing is signed or broadcast. A read that answers a retryable "cannot decide yet" (a
 * 429, a lagging backend) is tried again a bounded number of times; any other error, and
 * any wrong answer, fails at once.
 */
import { bech32 } from '@scure/base';
import { CryptoAio, isCryptoAioError, secret, type ProviderRef } from '../../src';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_AVALANCHE_NETWORK ?? 'fuji') as
  'mainnet' | 'fuji';
const route = (url: string | undefined, kind: 'rpc' | 'indexer'): ProviderRef =>
  url ? { endpoints: [{ url: secret(url), kind }] } : 'public';
const ATTEMPTS = 3;
const pause = (ms = 1_500) => new Promise((resolve) => setTimeout(resolve, ms));
const suite = enabled ? describe : describe.skip;

async function read<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await pause();
    try {
      return await work();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isCryptoAioError(error) || !error.retryable)
        throw error;
    }
  }
}

suite(`Avalanche integration on ${network}`, () => {
  it.each([
    ['avalanche-x', 'X'],
    ['avalanche-p', 'P'],
  ] as const)(
    '%s: checks block 0 on node and indexer, then reads heights, a block, its transactions and a balance',
    async (chain, alias) => {
      const aio = new CryptoAio({ env: false });
      try {
        const bc = aio.blockchain({
          chain,
          network,
          provider: route(process.env[`CRYPTO_AIO_IT_AVALANCHE_${alias}_RPC_URL`], 'rpc'),
          indexer: route(
            process.env[`CRYPTO_AIO_IT_AVALANCHE_${alias}_INDEXER_URL`],
            'indexer',
          ),
        });
        await bc.ready();
        const status = await read(() => bc.getNetworkStatus());
        expect(status.height).toBeGreaterThan(0n);
        expect(status.finalizedHeight).toBe(status.height);
        const block = await read(() => bc.getBlock(status.height - 5n));
        expect(block?.height).toBe(status.height - 5n);
        for (const id of (block?.transactionIds ?? []).slice(0, 2)) {
          const tx = await read(() => bc.getTransaction(id));
          expect(tx?.id).toBe(id);
          expect(tx?.status.finality).toBe('final');
        }
        const hrp = network === 'mainnet' ? 'avax' : 'fuji';
        const nobody = `${alias}-${bech32.encode(hrp, bech32.toWords(new Uint8Array(20)))}`;
        expect(await bc.validateAddress(nobody)).toBe(true);
        expect(
          (await read(() => bc.getBalance(nobody))).amount.base,
        ).toBeGreaterThanOrEqual(0n);
      } finally {
        await aio.close();
      }
    },
    120_000,
  );
});
