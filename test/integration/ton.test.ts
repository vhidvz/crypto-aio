/**
 * Opt-in, read-only checks against live toncenter, skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only:
 * - CRYPTO_AIO_IT_TON_NETWORK: `mainnet` or `testnet` (default `testnet`);
 * - CRYPTO_AIO_IT_TON_RPC_URL / CRYPTO_AIO_IT_TON_INDEXER_URL: API v2 / v3 base URLs
 *   (default: the keyless `public` preset), for keyed or self-hosted endpoints. Each gets
 *   the keyless preset's client-side rate limit (0.5 requests per second): a custom
 *   endpoint has none of its own, and toncenter answers a burst with HTTP 429. A key in the
 *   URL is kept in a `Secret`, and the transport scrubs it from errors both as the whole
 *   URL and as the bare query value an endpoint may echo back.
 *
 * Nothing is signed or broadcast. Each read waits a courtesy pause first. A read that
 * answers a retryable "cannot decide yet" (a 429, an index or a load-balanced backend that
 * lags) is tried again, a bounded number of times, the last time after the transport's
 * 15-second lockout of an endpoint that failed its identity check; any other error, and any
 * wrong answer, fails at once.
 */
import { randomBytes } from 'node:crypto';
import { CryptoAio, isCryptoAioError, secret, type ProviderRef } from '../../src';
import type { TonSeqnoOrdering } from '../../src/adapters/ton';
// The driver's token metadata read, which the public API reaches only through its cache.
import { internalsOf } from '../../src/core/blockchain/internal';
import type { TokenRef } from '../../src/core/model/asset';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_TON_NETWORK ?? 'testnet') as
  'mainnet' | 'testnet';
/** A custom endpoint gets the keyless preset's rate limit (`presets.ts`). */
const route = (url: string | undefined, kind: 'rpc' | 'indexer'): ProviderRef =>
  url ? { endpoints: [{ url: secret(url), kind, rateLimit: { rps: 0.5 } }] } : 'public';
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
const TIMEOUT_MS = 240_000;
const pause = (ms = 2_500) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The pause before the last attempt outlasts the transport's 15-second lockout of an
 * endpoint whose identity probe failed (a 429 on the probe counts as one).
 */
const LAST_PAUSE_MS = 16_000;
const suite = enabled ? describe : describe.skip;
/** The elector: an active system contract on every TON network, and no wallet. */
const ELECTOR = `-1:${'3'.repeat(64)}`;

/** One read after a courtesy pause, tried again only on a retryable crypto-aio error. */
async function read<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await pause(attempt === ATTEMPTS ? LAST_PAUSE_MS : undefined);
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
        // The same block by its hash, which the indexer (v3) resolves to its seqno and
        // the liteserver (v2) serves: both APIs on this network's chain.
        expect(await read(() => ton.getBlock(block?.hash ?? ''))).toEqual(block);
        const balance = await read(() => ton.getBalance(ZERO));
        expect(balance.amount.asset.id).toBe(`ton:${network}/native`);
        expect(await read(() => ton.ext.ton.getSeqno(ZERO))).toBe(0n);
        // The seqno get-method itself runs live, bound to the state's block; the elector
        // answers it without a seqno, so it is no wallet.
        await expect(read(() => ton.ext.ton.getSeqno(ELECTOR))).rejects.toMatchObject({
          code: 'INVALID_INTENT',
          message: 'the account is not a v4r2 or v5r1 wallet',
        });
      } finally {
        await aio.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    'proves live that a message never sent to a never used wallet did not land, once expired',
    async () => {
      const aio = new CryptoAio({ env: false });
      try {
        const ton = aio.blockchain({ chain: 'ton', network, provider, indexer });
        await pause();
        await ton.ready();
        const { driver } = await internalsOf(ton).pooled();
        // A lifetime that ended two minutes before the attested head, for a wallet that has
        // never existed: the proof reads the attested head, the wallet's state bound to it,
        // every shard top's time, and the indexer's history anchored there.
        const head = await read(() => driver.proofs.finalizedHead());
        const validUntil = (head.timestamp ?? 0) - 120;
        const ordering: TonSeqnoOrdering = {
          kind: 'seqno',
          seqno: 0n,
          validUntil,
          validFrom: validUntil - 60,
        };
        const wallet = `0:${randomBytes(32).toString('hex')}`;
        const ref = {
          id: randomBytes(32).toString('hex'),
          idKind: 'message-hash',
          canonical: false,
        } as const;
        expect(await read(() => driver.proofs.expired!(ordering))).toBe(true);
        expect(
          await read(() => driver.proofs.slotConsumed(ordering, wallet, 'finalized')),
        ).toBe(false);
        expect(
          await read(() => driver.proofs.includedFinal(ref, ordering, wallet)),
        ).toEqual({ included: false });
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
