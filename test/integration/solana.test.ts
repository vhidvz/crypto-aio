/**
 * Opt-in, read-only checks against a live Solana cluster (spec §17), skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only, never keys:
 * - CRYPTO_AIO_IT_SOLANA_NETWORK: `mainnet`, `devnet` (default) or `testnet`;
 * - CRYPTO_AIO_IT_SOLANA_RPC_URL: an endpoint URL (default: the `public` preset). If the URL
 *   embeds a key it stays redacted (a `Secret`), but prefer a keyless endpoint.
 *
 * Nothing is signed or broadcast, and no key or funded account is needed. The `public`
 * preset paces its requests, and the health probes wait for that limit too (A17), so the
 * steps need no pauses. Two reads are not ordered: behind a load balancer, or with
 * sub-second finality, a finalized height read after a head height can be the higher one,
 * so no check assumes it.
 *
 * The expiry proof (F5-R9 to F5-R11) runs on live blocks. The record a build keeps for its
 * blockhash (`SolanaExpiryOrdering`: the blockhash, the slot of its block and its last valid
 * height) is taken from a finalized block deep enough that its window has closed; it is
 * proven expired only once the quorum attests the blockhash's block, and a record taken from
 * `getLatestBlockhash` as a build takes it is not. The negative inclusion proof (lessons 16
 * and 17) then shows a signature that was never sent absent from every block of that closed
 * window. It reads the whole window, 151 blocks and more, so it runs only against
 * CRYPTO_AIO_IT_SOLANA_RPC_URL: the public endpoints answer about six `getBlock` calls per
 * 10 s (HTTP 429 with `Retry-After: 10` on devnet and testnet, September 2026), and a window
 * does not fit in a test's time at that pace. A proof that decides nothing is tried again a
 * few times, on a retryable error only.
 */
import { randomBytes } from 'node:crypto';
import { base58 } from '@scure/base';
import type { Connection } from '@solana/web3.js';
import { CryptoAio, isCryptoAioError, secret, type ProviderRef } from '../../src';
// Also types `native(bc, '@solana/web3.js')` as the Solana `Connection`.
import type { SolanaExpiryOrdering } from '../../src/adapters/solana';
import { BLOCKHASH_VALIDITY } from '../../src/adapters/solana/proofs';
// The proofs' own reads, which the public API does not expose (as the EVM and Tron suites).
import { internalsOf } from '../../src/core/blockchain/internal';
import { native } from '../../src/native';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_SOLANA_NETWORK ?? 'devnet') as
  'mainnet' | 'devnet' | 'testnet';
const url = process.env.CRYPTO_AIO_IT_SOLANA_RPC_URL;
const provider: ProviderRef = url ? { endpoints: [{ url: secret(url) }] } : 'public';
/** The System Program's address: always present, never a signer. */
const SYSTEM = '11111111111111111111111111111111';
/**
 * Two addresses derived from public test seeds (Plan 5 vectors). Nobody here funds them, but
 * anyone may, so no check depends on their balances.
 */
const SENDER = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
const RECIPIENT = '6zYdUwXJR5fhQJazDByGv4PsNrdaNhoruAR5kekA7rGs';
/**
 * How far below the finalized slot the closed window's blockhash sits: 400 slots, under
 * three minutes. Its window (the next 151 blocks) then closes about 250 blocks below the
 * finalized height, and still about 50 below it with half the slots skipped.
 */
const REFERENCE_DEPTH = 400;
/** The blockhash is the first block's in this many slots: a slot may hold none. */
const REFERENCE_SLOTS = 50;
/** Tries of a proof: an undecided answer is retried, `RETRY_MS` apart. */
const PROOF_TRIES = 3;
const RETRY_MS = 5_000;
const suite = enabled ? describe : describe.skip;
/** The whole-window proof needs an endpoint that serves 151 blocks in time (see above). */
const withEndpoint = url ? it : it.skip;

const open = (aio: CryptoAio) => aio.blockchain({ chain: 'solana', network, provider });

/**
 * `read`, tried again only on a retryable failure: a proof that decides nothing (lesson 16)
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
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

/**
 * What a build records from `getLatestBlockhash` (one bank's slot, its blockhash, and that
 * blockhash's last valid height), for a finalized block `REFERENCE_DEPTH` slots below the
 * finalized slot: a window that has closed. Read through the handle's native client.
 */
async function closedWindow(connection: Connection): Promise<SolanaExpiryOrdering> {
  const start = (await connection.getSlot('finalized')) - REFERENCE_DEPTH;
  const [slot] = await connection.getBlocks(start, start + REFERENCE_SLOTS, 'finalized');
  if (slot === undefined) {
    throw new Error(`no finalized block in slots ${start} to ${start + REFERENCE_SLOTS}`);
  }
  const block = await connection.getBlock(slot, {
    commitment: 'finalized',
    transactionDetails: 'none',
    rewards: false,
    maxSupportedTransactionVersion: 0,
  });
  // web3.js 1.99 parses the block's height but leaves it out of the returned type.
  const height = (block as { readonly blockHeight?: number | null } | null)?.blockHeight;
  if (block === null || typeof height !== 'number') {
    throw new Error(
      `the endpoint listed slot ${slot}, then served no block height there`,
    );
  }
  return {
    kind: 'expiry',
    blockhash: block.blockhash,
    blockhashSlot: BigInt(slot),
    lastValidHeight: BigInt(height) + BLOCKHASH_VALIDITY,
  };
}

/** What a build records: the latest `confirmed` blockhash, as the builder reads it. */
async function openWindow(connection: Connection): Promise<SolanaExpiryOrdering> {
  const { context, value } = await connection.getLatestBlockhashAndContext('confirmed');
  return {
    kind: 'expiry',
    blockhash: value.blockhash,
    blockhashSlot: BigInt(context.slot),
    lastValidHeight: BigInt(value.lastValidBlockHeight),
  };
}

suite(`Solana integration on ${network}`, () => {
  it('checks the genesis hash, then reads heights, a final block and its child, a balance and a fee', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      expect(status.finalizedHeight).toBeGreaterThan(0n);
      // The two heights are not ordered (see the header): only their gap is small.
      const gap = status.height - status.finalizedHeight;
      expect(gap < 1_000n && gap > -1_000n).toBe(true);
      // Heights are dense on a ledger with skipped slots: the next height is the child.
      const block = await bc.getBlock(status.finalizedHeight - 10n);
      expect(block?.height).toBe(status.finalizedHeight - 10n);
      expect(block?.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      const next = await bc.getBlock(status.finalizedHeight - 9n);
      expect(next?.height).toBe(status.finalizedHeight - 9n);
      expect(next?.parentHash).toBe(block?.hash);
      expect((await bc.getBalance(SYSTEM)).amount.asset.id).toBe(
        `solana:${network}/native`,
      );
      // A fee needs no signer and no funds. Whatever the simulation answers (a node's word:
      // without funds it fails and the limit falls back), getFeeForMessage prices it.
      const fee = await bc.estimateFee({
        to: RECIPIENT,
        amount: 1_000_000n,
        from: SENDER,
      });
      expect(fee.kind).toBe('solana');
      expect(fee.charges[0]).toMatchObject({ label: 'network' });
      expect(fee.charges[0]?.amount.base).toBeGreaterThan(0n);
    } finally {
      await aio.close();
    }
  }, 120_000);

  it('proves a closed window expired on its attested blockhash, and an open one not', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio);
      await bc.ready();
      const connection = await native(bc, '@solana/web3.js');
      const { driver } = await internalsOf(bc).pooled();
      const closed = await retried(() => closedWindow(connection));
      expect(await retried(() => driver.proofs.expired(closed))).toBe(true);
      const fresh = await retried(() => openWindow(connection));
      expect(await retried(() => driver.proofs.expired(fresh))).toBe(false);
    } finally {
      await aio.close();
    }
  }, 120_000);

  withEndpoint(
    'proves a signature that was never sent absent from its closed window',
    async () => {
      const aio = new CryptoAio({ env: false });
      try {
        const bc = open(aio);
        await bc.ready();
        const connection = await native(bc, '@solana/web3.js');
        const { driver } = await internalsOf(bc).pooled();
        const ordering = await retried(() => closedWindow(connection));
        const signature = base58.encode(randomBytes(64));
        const proof = await retried(() =>
          driver.proofs.includedFinal(
            { id: signature, idKind: 'signature', canonical: true },
            ordering,
            SENDER,
          ),
        );
        expect(proof).toEqual({ included: false });
      } finally {
        await aio.close();
      }
    },
    180_000,
  );
});
