/**
 * Opt-in, read-only checks against live toncenter (spec §17), skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only (D22):
 * - CRYPTO_AIO_IT_TON_NETWORK: `mainnet` or `testnet` (default `testnet`);
 * - CRYPTO_AIO_IT_TON_RPC_URL / CRYPTO_AIO_IT_TON_INDEXER_URL: API v2 / v3 base URLs
 *   (default: the keyless `public` preset). A URL carrying toncenter's `api_key` query
 *   parameter stays a redacted `Secret`, but prefer keyless endpoints.
 *
 * Nothing is signed or broadcast. The keyless preset allows one request per second, so each
 * read waits a courtesy pause first. A read that answers a retryable "cannot decide yet" (a
 * 429, an index or a load-balanced backend that lags) is tried again, a bounded number of
 * times; any other error, and any wrong answer, fails at once.
 */
import { CryptoAio, isCryptoAioError, secret, type ProviderRef } from '../../src';
// The driver's token metadata read, which the public API reaches only through its cache.
import { internalsOf } from '../../src/core/blockchain/internal';
import type { TokenRef } from '../../src/core/model/asset';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_TON_NETWORK ?? 'testnet') as
  'mainnet' | 'testnet';
const route = (url: string | undefined, kind: 'rpc' | 'indexer'): ProviderRef =>
  url ? { endpoints: [{ url: secret(url), kind }] } : 'public';
const provider = route(process.env.CRYPTO_AIO_IT_TON_RPC_URL, 'rpc');
const indexer = route(process.env.CRYPTO_AIO_IT_TON_INDEXER_URL, 'indexer');
/** No `StateInit` hashes to the zero address, so it is never deployed: its seqno is 0. */
const ZERO = `0:${'0'.repeat(64)}`;
/**
 * How far below the finalized height the block read goes: the network's `maxLagBlocks`
 * (150, about a minute), so a load-balanced backend that trails the one that gave the
 * height, by less than the pool would tolerate, still holds the block.
 */
const BLOCK_DEPTH = 150n;
/** Each read's attempts: the first, and two more after a retryable answer. */
const ATTEMPTS = 3;
/** Several reads, each after a pause and up to three transport attempts, per test. */
const TIMEOUT_MS = 180_000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 2_500));
const suite = enabled ? describe : describe.skip;

/** One read after a courtesy pause, tried again only on a retryable crypto-aio error. */
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

suite(`TON integration on ton:${network}`, () => {
  it(
    'checks the global id on both APIs, then reads heights, a block, a balance and a seqno',
    async () => {
      const aio = new CryptoAio({ env: false });
      try {
        const ton = aio.blockchain({ chain: 'ton', network, provider, indexer });
        await ton.ready();
        const status = await read(() => ton.getNetworkStatus());
        expect(status.height).toBeGreaterThan(0n);
        expect(status.finalizedHeight).toBeLessThanOrEqual(status.height);
        const height = status.finalizedHeight - BLOCK_DEPTH;
        const block = await read(() => ton.getBlock(height));
        expect(block?.height).toBe(height);
        expect(block?.hash).toMatch(/^[0-9a-f]{64}$/);
        const balance = await read(() => ton.getBalance(ZERO));
        expect(balance.amount.asset.id).toBe(`ton:${network}/native`);
        expect(await read(() => ton.ext.ton.getSeqno(ZERO))).toBe(0n);
      } finally {
        await aio.close();
      }
    },
    TIMEOUT_MS,
  );

  (network === 'mainnet' ? it : it.skip)(
    "reads USDT's decimals from the master's on-chain content",
    async () => {
      const aio = new CryptoAio({ env: false });
      try {
        const ton = aio.blockchain({ chain: 'ton', network, provider, indexer });
        await pause();
        await ton.ready();
        const usdt = await ton.resolveAsset('USDT');
        const { driver } = await internalsOf(ton).pooled();
        const metadata = await read(() =>
          driver.reader.getTokenMetadata!(usdt.ref as TokenRef),
        );
        expect(metadata.decimals).toBe(usdt.metadata.decimals);
      } finally {
        await aio.close();
      }
    },
    TIMEOUT_MS,
  );
});
