/**
 * Opt-in, read-only checks against a live Tron network (spec §17), skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only, never keys:
 * - CRYPTO_AIO_IT_TRON_NETWORK: `mainnet`, `shasta` or `nile` (default `nile`);
 * - CRYPTO_AIO_IT_TRON_URL: an endpoint base URL serving `/wallet`, `/walletsolidity` and
 *   `/jsonrpc` (default: the `public` preset, TronGrid without a key).
 *
 * Nothing is signed or broadcast. The builder refuses a head older than half the expiration
 * window, so the first check also reads the head's age against the local clock. The negative
 * inclusion proof (F4-R12, F4-R14) runs on live blocks: a transaction id that was never built,
 * with a `TronExpiryOrdering` naming a solidified block as its reference, is proven absent
 * from the attested reference block and a scan up to the first block past its expiration.
 */
import { randomBytes } from 'node:crypto';
import { CryptoAio, secret, type ProviderRef } from '../../src';
import { DEFAULT_EXPIRATION_MS, type TronExpiryOrdering } from '../../src/adapters/tron';
import { TAPOS_WINDOW } from '../../src/adapters/tron/network';
// The proofs' own read, which the public API does not expose (as the EVM suite's R78 probe).
import { internalsOf } from '../../src/core/blockchain/internal';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_TRON_NETWORK ?? 'nile') as
  'mainnet' | 'shasta' | 'nile';
const url = process.env.CRYPTO_AIO_IT_TRON_URL;
const provider: ProviderRef = url ? { endpoints: [{ url: secret(url) }] } : 'public';
/** The black-hole account, which exists on every Tron network. */
const BLACK_HOLE = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
/**
 * How far below the solidified head the proof's reference block sits: 40 blocks, about two
 * minutes, so its one-minute expiration window closes well below the solidified head.
 */
const REFERENCE_DEPTH = 40n;
const suite = enabled ? describe : describe.skip;

const open = (aio: CryptoAio) => aio.blockchain({ chain: 'tron', network, provider });

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
      // A build here would reference this head, and refuses one older than half the window.
      const head = await bc.getBlock(status.height);
      expect(Date.now() - Number(head?.timestamp)).toBeLessThanOrEqual(
        DEFAULT_EXPIRATION_MS / 2,
      );
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
  }, 60_000);

  it('proves a transaction id that was never built absent after its expiration', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      const { finalizedHeight } = await bc.getNetworkStatus();
      const reference = await bc.getBlock(finalizedHeight - REFERENCE_DEPTH);
      if (reference?.timestamp === undefined) throw new Error('no reference block');
      // What a build on this reference block would record (the builder's ordering).
      const ordering: TronExpiryOrdering = {
        kind: 'expiry',
        expiresAtMs: reference.timestamp + DEFAULT_EXPIRATION_MS,
        lastValidHeight: reference.height + TAPOS_WINDOW,
        refBlockHash: reference.hash.slice(16, 32),
      };
      const id = randomBytes(32).toString('hex');
      const { driver } = await internalsOf(bc).pooled();
      await expect(
        driver.proofs.includedFinal(
          { id, idKind: 'tx-hash', canonical: true },
          ordering,
          BLACK_HOLE,
        ),
      ).resolves.toEqual({ included: false });
    } finally {
      await aio.close();
    }
  }, 60_000);
});
