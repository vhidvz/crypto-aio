/**
 * Opt-in, read-only checks against a live Tron network, skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only, never keys:
 * - CRYPTO_AIO_IT_TRON_NETWORK: `mainnet`, `shasta` or `nile` (default `nile`);
 * - CRYPTO_AIO_IT_TRON_URL: an endpoint base URL serving `/wallet`, `/walletsolidity` and
 *   `/jsonrpc` (default: the `public` preset, TronGrid without a key).
 *
 * Nothing is signed or broadcast. The builder refuses a head older than half the expiration
 * window, and a clock lagging the network by nearly a window makes every build expire at
 * birth, so one check reads the head's age by the local clock as the builder does. The
 * negative inclusion proof runs on live blocks: a transaction id that was
 * never built, with a `TronExpiryOrdering` naming a solidified block as its reference, is
 * proven absent from every block above the attested reference block, up to the first block
 * at or past its expiration.
 */
import { randomBytes } from 'node:crypto';
import { CryptoAio, isCryptoAioError, secret, type ProviderRef } from '../../src';
import {
  DEFAULT_EXPIRATION_MS,
  MIN_EXPIRATION_MS,
  type TronExpiryOrdering,
} from '../../src/adapters/tron';
import { TAPOS_WINDOW } from '../../src/adapters/tron/network';
// The proofs' own read, which the public API does not expose (as the EVM suite's probe).
import { internalsOf } from '../../src/core/blockchain/internal';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_TRON_NETWORK ?? 'nile') as
  'mainnet' | 'shasta' | 'nile';
const url = process.env.CRYPTO_AIO_IT_TRON_URL;
const provider: ProviderRef = url ? { endpoints: [{ url: secret(url) }] } : 'public';
/** The black-hole account, which exists on every Tron network. */
const BLACK_HOLE = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
/** One block slot. */
const SLOT_MS = 3_000;
/**
 * How far below the solidified head the proof's reference block sits: 40 blocks, about two
 * minutes, so its expiration window closes well below the solidified head.
 */
const REFERENCE_DEPTH = 40n;
/** Tries of the proof: an undecided answer is retried, one slot apart. */
const PROOF_TRIES = 3;
const suite = enabled ? describe : describe.skip;

const open = (aio: CryptoAio) => aio.blockchain({ chain: 'tron', network, provider });

/**
 * `read`, tried again only on a retryable failure: a proof that decides nothing
 * answered correctly, and a lagging load-balanced backend or a 429 passes.
 */
async function retried<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= PROOF_TRIES || !isCryptoAioError(error) || !error.retryable) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SLOT_MS));
    }
  }
}

suite(`Tron integration on ${network}`, () => {
  it('checks block 0, then reads heights, a solidified block, a balance and a fee', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      expect(status.finalizedHeight).toBeGreaterThan(0n);
      expect(status.finalizedHeight).toBeLessThanOrEqual(status.height);
      const block = await bc.getBlock(status.finalizedHeight);
      expect(block?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await bc.getBalance(BLACK_HOLE)).amount.asset.id).toBe(
        `tron:${network}/native`,
      );
      const fee = await bc.estimateFee({
        to: BLACK_HOLE,
        amount: 1n,
        from: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
      });
      expect(fee.kind).toBe('tron');
      expect(fee.charges[0]?.label).toBe('bandwidth');
    } finally {
      await aio.close();
    }
  }, 120_000);

  it('reads a head that a build would accept, by the local clock', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      // As the builder does: the head, then the clock at once. The block's time comes after,
      // so the second read's latency is not counted as the head's age.
      const height = await bc.getBlockHeight();
      const seenAt = Date.now();
      const head = await bc.getBlock(height);
      if (head?.timestamp === undefined) {
        throw new Error(`the endpoint named head ${height}, then served no block there`);
      }
      const age = seenAt - head.timestamp;
      // The builder refuses a head older than half the window, and anchors the expiration at
      // the earlier of the head's time and the clock: a clock behind the head by the window
      // less one slot builds transactions that expire at birth.
      if (age > DEFAULT_EXPIRATION_MS / 2) {
        throw new Error(
          `the head block is ${age} ms old by the local clock: the local clock leads the network, or the endpoint serves a stale head; every build would be refused`,
        );
      }
      if (-age > DEFAULT_EXPIRATION_MS - SLOT_MS) {
        throw new Error(
          `the head block is ${-age} ms ahead of the local clock: the local clock lags the network; every build would expire at birth`,
        );
      }
    } finally {
      await aio.close();
    }
  }, 120_000);

  it('proves a transaction id that was never built absent after its expiration', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      const { finalizedHeight } = await bc.getNetworkStatus();
      const reference = await bc.getBlock(finalizedHeight - REFERENCE_DEPTH);
      if (reference?.timestamp === undefined) throw new Error('no reference block');
      // What a build on this reference block records with the shortest window the network
      // config accepts and no jitter: the scan then walks about four blocks.
      const ordering: TronExpiryOrdering = {
        kind: 'expiry',
        expiresAtMs: reference.timestamp + MIN_EXPIRATION_MS,
        lastValidHeight: reference.height + TAPOS_WINDOW,
        refBlockHash: reference.hash.slice(16, 32),
      };
      const id = randomBytes(32).toString('hex');
      const { driver } = await internalsOf(bc).pooled();
      const proof = await retried(() =>
        driver.proofs.includedFinal(
          { id, idKind: 'tx-hash', canonical: true },
          ordering,
          BLACK_HOLE,
        ),
      );
      expect(proof).toEqual({ included: false });
    } finally {
      await aio.close();
    }
  }, 180_000);
});
