/**
 * The built-in TON chain: mainnet and testnet. Every value is verified, live on toncenter
 * or against docs.ton.org and ton.org, or is a documented library policy:
 * - `identity`: the network's global id (config param 19), which the identity probe reads.
 * - The native coin is Gram (ticker GRAM, formerly Toncoin), 9 decimals; the plugin also
 *   registers the alias `TON` for it.
 * - `finality: masterchain`: a masterchain block is final once it exists (BFT).
 * - `maxLagBlocks: 150`: library policy, about 60 s of masterchain blocks (measured ~0.4 s
 *   apart).
 * - `reorgWindow: 16`: library policy, unused; TON has no block source (sharded).
 * - `params`: `validForSeconds` (a message's lifetime, from chain time), `jettonAttached`
 *   and `jettonForwardAmount` (nanograms per jetton transfer), `finalitySkewBlocks` (how far
 *   a healthy proof peer may trail the freshest endpoint), all library policy.
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { deepFreeze } from '../../core/util/freeze';

function tonNetwork(
  id: string,
  globalId: number,
  testnet: boolean,
  explorer: string,
): NetworkInfo {
  return {
    id,
    identity: String(globalId),
    testnet,
    feeModel: 'ton',
    finality: { kind: 'masterchain' },
    defaultConfirmations: 1,
    reorgWindow: 16,
    maxLagBlocks: 150,
    explorer: { tx: `${explorer}/transaction/{id}`, address: `${explorer}/{address}` },
    params: {
      validForSeconds: 60,
      jettonAttached: 50_000_000n,
      jettonForwardAmount: 1n,
      finalitySkewBlocks: 10,
    },
  };
}

export const TON_CHAINS: readonly ChainInfo[] = deepFreeze([
  {
    id: 'ton',
    family: 'ton',
    model: 'account',
    ordering: 'seqno',
    schemes: ['ed25519'],
    nativeAsset: { symbol: 'GRAM', decimals: 9, name: 'Gram' },
    defaultNetwork: 'mainnet',
    networks: {
      mainnet: tonNetwork('mainnet', -239, false, 'https://tonviewer.com'),
      testnet: tonNetwork('testnet', -3, true, 'https://testnet.tonviewer.com'),
    },
  },
]);
