/**
 * Opt-in, read-only checks against a live Bitcoin network over Esplora, skipped
 * unless CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only:
 * - CRYPTO_AIO_IT_UTXO_NETWORK: `mainnet`, `testnet`, `testnet4` or `signet` (default `signet`);
 * - CRYPTO_AIO_IT_UTXO_PROVIDER: a preset, `blockstream` or `mempool` (default `blockstream`).
 *   `testnet4` needs `mempool`: the `blockstream` preset has no testnet4.
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
/** Bitcoin mainnet's genesis block hash: its identity. */
const MAINNET_GENESIS =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
/** BIP30: block 91842's coinbase repeats the txid of block 91812's. */
const BIP30_COINBASE = 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599';

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
        // A test network's estimates can exceed the 200 sat/vB an estimate may set,
        // which refuses them, retryably, by design; this handle takes up to 1,000 sat/vB.
        options: { maxEstimatedFeeRate: 1_000_000n },
      });
      await bc.ready();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      // Two concurrent reads, possibly on different backends, may land a block apart
      // either way; the gap is 5 (six confirmations) give or take that block.
      expect([4n, 5n, 6n]).toContain(status.height - status.finalizedHeight);
      const block = await bc.getBlock(status.finalizedHeight);
      expect(block?.hash).toMatch(/^[0-9a-f]{64}$/);
      // A block scan accepts a page only when every transaction on
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
        // nothing to select, the fee is that of the bare transaction, at the default speed.
        const from = client.bitcoin.payments.p2wpkh({
          hash: Buffer.from(coinbase.slice(0, 40), 'hex'),
          network: client.network,
        }).address;
        const fee = await bc.estimateFee({ to: payee, amount: 10_000n, from });
        expect(fee.kind).toBe('utxo');
        expect(fee.charges[0]?.amount.base).toBeGreaterThan(0n);
      }
    } finally {
      await aio.close();
    }
  }, 120_000);

  it("labels BIP30's repeated coinbase with the page's own block, on mainnet only", async () => {
    // On an ordinary block a page status and the transaction's own status agree, so only a
    // repeated txid tells the labellings apart. A network fact, gated by the network's
    // identity (its genesis hash), never by a height on another network.
    const aio = new CryptoAio({ env: false });
    try {
      const bc = aio.blockchain({
        chain: 'bitcoin',
        network,
        provider,
        indexer: provider,
      });
      const client = await native(bc, 'bitcoinjs-lib');
      const genesis = (await client.esplora<string>('/block-height/0', 'text')).trim();
      if (genesis !== MAINNET_GENESIS) return;
      const hash = (await client.esplora<string>('/block-height/91842', 'text')).trim();
      const page = await client.esplora<PageTx[]>(`/block/${hash}/txs/0`);
      expect(page[0]).toMatchObject({
        txid: BIP30_COINBASE,
        status: { confirmed: true, block_height: 91842, block_hash: hash },
      });
      // The transaction's own status names the first block that holds it.
      const own = await client.esplora<PageTx['status']>(`/tx/${BIP30_COINBASE}/status`);
      expect(own.block_height).toBe(91812);
      expect((await bc.getBlock(91842n))?.transactionIds?.[0]).toBe(BIP30_COINBASE);
    } finally {
      await aio.close();
    }
  }, 120_000);
});
