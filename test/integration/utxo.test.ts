/**
 * Opt-in, read-only checks against a live Bitcoin network over Esplora (spec §17), skipped
 * unless CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only:
 * - CRYPTO_AIO_IT_UTXO_NETWORK: `mainnet`, `testnet`, `testnet4` or `signet` (default `signet`);
 * - CRYPTO_AIO_IT_UTXO_PROVIDER: a preset, `blockstream` or `mempool` (default `blockstream`).
 */
import { CryptoAio } from '../../src';
import { native } from '../../src/native';
// Types `native(bc, 'bitcoinjs-lib')` as the UTXO native client.
import '../../src/adapters/utxo';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_UTXO_NETWORK ?? 'signet') as
  'mainnet' | 'testnet' | 'testnet4' | 'signet';
const provider = process.env.CRYPTO_AIO_IT_UTXO_PROVIDER ?? 'blockstream';
const suite = enabled ? describe : describe.skip;

/** Esplora's `/block/:hash/txs/:start` page size. */
const PAGE = 25;

interface PageTx {
  readonly txid: string;
  readonly status: {
    readonly confirmed: boolean;
    readonly block_height?: number;
    readonly block_hash?: string;
  };
}

suite(`UTXO integration on bitcoin:${network} (${provider})`, () => {
  it('checks the genesis hash, then reads heights, a final block, its transactions and a fee', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = aio.blockchain({
        chain: 'bitcoin',
        network,
        provider,
        indexer: provider,
      });
      await bc.ready();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      // M14: two concurrent reads, possibly on different backends, may land a block apart
      // either way; the gap is 5 (six confirmations) give or take that block.
      expect([4n, 5n, 6n]).toContain(status.height - status.finalizedHeight);
      const block = await bc.getBlock(status.finalizedHeight);
      expect(block?.hash).toMatch(/^[0-9a-f]{64}$/);
      // D-T9-2 (F3-R12, F3-R17): a block scan accepts a page only when every transaction on
      // it is confirmed in that very block. A provider that labelled each status with the
      // transaction's own confirmation would stall scans forever at BIP30's duplicate
      // coinbases, so the page must name the block it was read from.
      const hash = block?.hash ?? '';
      const client = await native(bc, 'bitcoinjs-lib');
      const page = await client.esplora<PageTx[]>(`/block/${hash}/txs/0`);
      expect(
        page.map((t) => [
          t.txid,
          t.status.confirmed,
          t.status.block_hash,
          t.status.block_height,
        ]),
      ).toEqual(
        (block?.transactionIds ?? [])
          .slice(0, PAGE)
          .map((txid) => [txid, true, hash, Number(status.finalizedHeight)]),
      );
      const coinbase = block?.transactionIds?.[0] ?? '';
      const tx = await bc.getTransaction(coinbase);
      expect(tx?.block?.height).toBe(status.finalizedHeight);
      expect(tx?.decoding).toBe('complete');
      const payee = tx?.transfers.find((t) => t.unresolved === undefined)?.to.canonical;
      if (payee) {
        expect((await bc.getBalance(payee)).amount.asset.id).toBe(
          `bitcoin:${network}/native`,
        );
        // A pool's payout address often holds more unspent outputs than the public services
        // list (`/address/:address/utxo` answers HTTP 400 past 500), so the estimate spends
        // from an address nobody funds: a p2wpkh program cut from the coinbase txid. With
        // nothing to select, the fee is that of the bare transaction. The speed is `slow`
        // because a test network's fast targets can exceed the 200 sat/vB an estimate may
        // set (M3), which refuses them with a retryable error by design.
        const from = client.bitcoin.payments.p2wpkh({
          hash: Buffer.from(coinbase.slice(0, 40), 'hex'),
          network: client.network,
        }).address;
        const fee = await bc.estimateFee({
          to: payee,
          amount: 10_000n,
          from,
          fee: 'slow',
        });
        expect(fee.kind).toBe('utxo');
        expect(fee.charges[0]?.amount.base).toBeGreaterThan(0n);
      }
    } finally {
      await aio.close();
    }
  }, 120_000);
});
