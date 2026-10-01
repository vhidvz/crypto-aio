/**
 * The built-in Tron chain (spec §2): mainnet, Shasta and Nile. Every value is verified
 * against the source named in the Plan 4 appendix, or is a documented library policy:
 * - `identity`: the id of block 0, read from each network's TronGrid endpoint.
 * - `defaultConfirmations: 1`: `waitForConfirmation` waits for inclusion by default;
 *   credit deposits on `final` (the solidified block).
 * - `reorgWindow: 64`: the scanner's window, about three times the solidification depth.
 * - `maxLagBlocks: 20`: about 60 seconds of 3-second blocks.
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { deepFreeze } from '../../core/util/freeze';

function tronNetwork(
  id: string,
  identity: string,
  testnet: boolean,
  explorer: string,
): NetworkInfo {
  return {
    id,
    identity,
    testnet,
    feeModel: 'tron',
    finality: { kind: 'solidified' },
    defaultConfirmations: 1,
    reorgWindow: 64,
    maxLagBlocks: 20,
    explorer: {
      tx: `${explorer}/#/transaction/{id}`,
      address: `${explorer}/#/address/{address}`,
    },
  };
}

export const TRON_CHAIN: ChainInfo = deepFreeze({
  id: 'tron',
  family: 'tron',
  model: 'account',
  ordering: 'expiry',
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'TRX', decimals: 6 },
  defaultNetwork: 'mainnet',
  networks: {
    mainnet: tronNetwork(
      'mainnet',
      '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
      false,
      'https://tronscan.org',
    ),
    shasta: tronNetwork(
      'shasta',
      '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e',
      true,
      'https://shasta.tronscan.org',
    ),
    nile: tronNetwork(
      'nile',
      '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
      true,
      'https://nile.tronscan.org',
    ),
  },
});
