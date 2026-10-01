/**
 * The built-in Avalanche X-Chain and P-Chain (the primary network's UTXO chains) on mainnet
 * and Fuji. The C-Chain is the EVM chain `avalanche`. Values verified on 2026-10-01 against
 * the public API (`api.avax.network`, `api.avax-test.network`) and the Avalanche Data API:
 * - `identity`: the id of the chain's block at height 0, which the identity probe reads
 *   (for the X-Chain, the block that linearized it in the Cortina upgrade).
 * - `params.networkId` (1, 5) and `hrp` (`avax`, `fuji`): the address and transaction
 *   network; `blockchainId`: the chain's own id, written into every transaction;
 *   `avaxAssetId`: AVAX's asset id on the network.
 * - AVAX has 9 decimals on these chains (nAVAX), unlike the C-Chain's 18.
 * - `finality: 1 confirmation`: Snowman consensus never reverts an accepted block, so a
 *   transaction in an accepted block is final; `defaultConfirmations: 1`.
 * Library policy: `reorgWindow: 8` (accepted blocks never roll back; the window only
 * catches an inconsistent provider) and `maxLagBlocks` (2 on the X-Chain, whose blocks are
 * minutes apart, 6 on the P-Chain, seconds apart). Since Durango the P-Chain refuses a
 * memo, so its networks remove the `memo` capability.
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { AvalancheVm } from './types';

interface NetworkSpec {
  readonly id: 'mainnet' | 'fuji';
  readonly testnet: boolean;
  readonly networkId: number;
  readonly hrp: string;
  readonly avaxAssetId: string;
  readonly x: { readonly blockchainId: string; readonly genesis: string };
  readonly p: { readonly blockchainId: string; readonly genesis: string };
}

const NETWORKS: readonly NetworkSpec[] = [
  {
    id: 'mainnet',
    testnet: false,
    networkId: 1,
    hrp: 'avax',
    avaxAssetId: 'FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z',
    x: {
      blockchainId: '2oYMBNV4eNHyqk2fjjV5nVQLDbtmNJzq5s3qs3Lo6ftnC6FByM',
      genesis: 'V8kYdATLoVjUBazVjEHy1dWurk2PcnhERSWnwmcNwirdsBb1S',
    },
    p: {
      blockchainId: '11111111111111111111111111111111LpoYY',
      genesis: '2FUFPVPxbTpKNn39moGSzsmGroYES4NZRdw3mJgNvMkMiMHJ9e',
    },
  },
  {
    id: 'fuji',
    testnet: true,
    networkId: 5,
    hrp: 'fuji',
    avaxAssetId: 'U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK',
    x: {
      blockchainId: '2JVSBoinj9C2J33VntvzYtVJNZdN2NKiwwKjcumHUWEb5DbBrm',
      genesis: '2tCdy3dRsf6rYG7jtBNSyANQ6StrAEYpCDMLBQyGRLF8wG5KPK',
    },
    p: {
      blockchainId: '11111111111111111111111111111111LpoYY',
      genesis: '99BWrAqUMvTp9nXKXyjPsCqjGwDqVFqssTRQbu58af57Cf9VG',
    },
  },
];

function network(spec: NetworkSpec, vm: AvalancheVm): NetworkInfo {
  const own = vm === 'avm' ? spec.x : spec.p;
  return {
    id: spec.id,
    identity: own.genesis,
    testnet: spec.testnet,
    feeModel: vm === 'avm' ? 'avalanche-static' : 'avalanche-dynamic',
    finality: { kind: 'confirmations', confirmations: 1 },
    defaultConfirmations: 1,
    reorgWindow: 8,
    maxLagBlocks: vm === 'avm' ? 2 : 6,
    ...(vm === 'pvm' ? { capabilities: { remove: ['memo'] } } : {}),
    params: {
      vm,
      alias: vm === 'avm' ? 'X' : 'P',
      networkId: spec.networkId,
      hrp: spec.hrp,
      blockchainId: own.blockchainId,
      avaxAssetId: spec.avaxAssetId,
    },
  };
}

/** R56: exported data is frozen all the way down. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function chain(id: string, vm: AvalancheVm): ChainInfo {
  return {
    id,
    family: 'avalanche',
    model: 'utxo',
    ordering: 'inputs',
    schemes: ['secp256k1-ecdsa'],
    nativeAsset: { symbol: 'AVAX', decimals: 9, name: 'Avalanche' },
    defaultNetwork: 'mainnet',
    // Avalanche wallets export `xpub` on every network: no SLIP-0132 network class.
    xpubNetworkClass: false,
    networks: Object.fromEntries(NETWORKS.map((spec) => [spec.id, network(spec, vm)])),
  };
}

export const AVALANCHE_X_CHAIN: ChainInfo = deepFreeze(chain('avalanche-x', 'avm'));
export const AVALANCHE_P_CHAIN: ChainInfo = deepFreeze(chain('avalanche-p', 'pvm'));

export const AVALANCHE_CHAINS: readonly ChainInfo[] = deepFreeze([
  AVALANCHE_X_CHAIN,
  AVALANCHE_P_CHAIN,
]);
