/**
 * The built-in Solana chain and its clusters. Every value is verified against a live node
 * (`getGenesisHash` on each cluster's public endpoint) or a published source, or is a
 * documented library policy:
 * - `identity`: the cluster's genesis hash (`getGenesisHash`), checked on every endpoint.
 * - `finality`: the `finalized` commitment.
 * - `defaultConfirmations: 1`: `waitForConfirmation` waits for inclusion at `confirmed` by
 *   default; credit deposits on `final`.
 * - `reorgWindow: 64` and `maxLagBlocks: 150`: library policies in block heights (a
 *   blockhash is valid for 150 blocks, so an endpoint further behind cannot judge expiry).
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { deepFreeze } from '../../core/util/freeze';

const EXPLORER = 'https://explorer.solana.com';

function cluster(
  id: 'mainnet' | 'devnet' | 'testnet',
  genesisHash: string,
  explorerCluster?: 'devnet' | 'testnet',
): NetworkInfo {
  const query = explorerCluster ? `?cluster=${explorerCluster}` : '';
  return {
    id,
    identity: genesisHash,
    testnet: id !== 'mainnet',
    feeModel: 'solana',
    finality: { kind: 'commitment', level: 'finalized' },
    defaultConfirmations: 1,
    reorgWindow: 64,
    maxLagBlocks: 150,
    explorer: {
      tx: `${EXPLORER}/tx/{id}${query}`,
      address: `${EXPLORER}/address/{address}${query}`,
    },
  };
}

export const SOLANA_CHAIN: ChainInfo = deepFreeze({
  id: 'solana',
  family: 'solana',
  model: 'account',
  ordering: 'expiry',
  schemes: ['ed25519'],
  nativeAsset: { symbol: 'SOL', decimals: 9, name: 'Solana' },
  defaultNetwork: 'mainnet',
  networks: {
    mainnet: cluster('mainnet', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    devnet: cluster('devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'devnet'),
    testnet: cluster(
      'testnet',
      '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
      'testnet',
    ),
  },
});
