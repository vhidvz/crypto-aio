/**
 * Opt-in, read-only checks against a live EVM testnet (spec §17), skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only, never keys:
 * - CRYPTO_AIO_IT_EVM_NETWORK: `<chain>:<network>` (default `base:sepolia`);
 * - CRYPTO_AIO_IT_EVM_RPC_URL: an endpoint URL (default: the chain's `public` preset). If
 *   the URL embeds a key it stays redacted (a `Secret`), but prefer a keyless endpoint.
 *
 * The finalized-state probe (R78) reads account state at the finalized block, as the proofs
 * do before they call an Attempt replaced. On OP Stack and Arbitrum chains that block lies
 * far below the head, beyond a non-archive node's recent-state window, so the endpoint may
 * not serve it. The probe passes either way, but a failure must be a classified crypto-aio
 * error, never a verdict; it logs one line saying which it was.
 */
import {
  CryptoAio,
  isCryptoAioError,
  secret,
  type ChainId,
  type ProviderRef,
} from '../../src';
// R78: the proofs' own finalized-state read, which the public API does not expose.
import { internalsOf } from '../../src/core/blockchain/internal';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const [chain, network] = (process.env.CRYPTO_AIO_IT_EVM_NETWORK ?? 'base:sepolia').split(
  ':',
) as [string, string];
const url = process.env.CRYPTO_AIO_IT_EVM_RPC_URL;
const provider: ProviderRef = url ? { endpoints: [{ url: secret(url) }] } : 'public';
const ZERO = '0x0000000000000000000000000000000000000000';
const suite = enabled
  ? describe.each(['ethers', 'web3'] as const)
  : describe.skip.each(['ethers', 'web3'] as const);

const open = (aio: CryptoAio, library: 'ethers' | 'web3') =>
  aio.blockchain({
    chain: chain as ChainId,
    network: network as never,
    library,
    provider,
  });

suite(`EVM integration on ${chain}:${network} (%s)`, (library) => {
  it('checks the chain id, then reads heights, a final block and a balance', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio, library);
      await bc.ready();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      expect(status.finalizedHeight).toBeGreaterThan(0n);
      // The status reads both heights at once, and where the latest block is final
      // (Avalanche) one can land between the reads: compare with a later head.
      expect(status.finalizedHeight).toBeLessThanOrEqual(await bc.getBlockHeight());
      const block = await bc.getBlock(status.finalizedHeight);
      expect(block?.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await bc.getBalance(ZERO)).amount.asset.id).toBe(
        `${chain}:${network}/native`,
      );
      const fee = await bc.estimateFee({ to: ZERO, amount: 1n, from: ZERO });
      expect(fee.charges[0]?.amount.base).toBeGreaterThan(0n);
    } finally {
      await aio.close();
    }
  }, 60_000);

  it('reads the finalized state, or fails with a classified error (R78)', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = open(aio, library);
      await bc.ready();
      const { driver } = await internalsOf(bc).pooled();
      // The finalized state is a prefix of the latest one, so the next nonce per the latest
      // block is still unconsumed at the finalized block.
      const next = await driver.sequence!.latest(ZERO);
      const outcome = await driver.proofs
        .slotConsumed({ kind: 'nonce', nonce: next }, ZERO, 'finalized')
        .then(
          (consumed) => ({ consumed }),
          (error: unknown) => ({ error }),
        );
      const label = `${chain}:${network} (${library})`;
      if ('consumed' in outcome) {
        expect(outcome.consumed).toBe(false);
        console.info(`${label}: the endpoint serves the finalized state`);
        return;
      }
      const { error } = outcome;
      if (!isCryptoAioError(error)) throw error;
      // A thrown provider error is no verdict; the URL (a Secret when given) never shows.
      expect(error.category).toBe('provider');
      if (url) expect(error.message.includes(url)).toBe(false);
      console.info(
        `${label}: the endpoint does not serve the finalized state (${error.code}): ${error.message}`,
      );
    } finally {
      await aio.close();
    }
  }, 60_000);
});
