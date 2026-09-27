/**
 * The built-in Bitcoin chain and networks (spec §2). Genesis hashes, address prefixes and
 * relay-policy numbers are verified against the sources named in the Plan 3 appendix; the
 * rest is library policy:
 * - `finality: 6 confirmations` on every network, `defaultConfirmations: 1`
 *   (`waitForConfirmation` waits for inclusion by default; credit deposits on `final`).
 * - `reorgWindow: 24` (four times the finality depth).
 * - `maxLagBlocks`: 2 on mainnet and signet, 6 on the testnets (their 20-minute
 *   minimum-difficulty rule produces bursts of blocks), the transport default on regtest.
 * - `minRelayFee` and `incrementalRelayFee` 1,000 sat/kvB (1 sat/vB): the defaults of
 *   Bitcoin Core before v30, so older nodes relay what this library builds.
 * - `feeFallback`: the rate used when a test network's estimator has no data (never on
 *   mainnet, where a missing estimate fails the read instead).
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';

interface NetworkSpec {
  readonly id: string;
  readonly genesis: string;
  readonly testnet: boolean;
  readonly bech32: string;
  readonly pubKeyHash: number;
  readonly scriptHash: number;
  readonly explorer?: string;
  readonly maxLagBlocks?: number;
  readonly feeFallback?: bigint;
}

const NETWORKS: readonly NetworkSpec[] = [
  {
    id: 'mainnet',
    genesis: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    testnet: false,
    bech32: 'bc',
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    explorer: 'https://blockstream.info',
    maxLagBlocks: 2,
  },
  {
    id: 'testnet',
    genesis: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    testnet: true,
    bech32: 'tb',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    explorer: 'https://blockstream.info/testnet',
    maxLagBlocks: 6,
    feeFallback: 1_000n,
  },
  {
    id: 'testnet4',
    genesis: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
    testnet: true,
    bech32: 'tb',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    maxLagBlocks: 6,
    feeFallback: 1_000n,
  },
  {
    id: 'signet',
    genesis: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
    testnet: true,
    bech32: 'tb',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    explorer: 'https://blockstream.info/signet',
    maxLagBlocks: 2,
    feeFallback: 1_000n,
  },
  {
    id: 'regtest',
    genesis: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
    testnet: true,
    bech32: 'bcrt',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    feeFallback: 1_000n,
  },
];

function network(spec: NetworkSpec): NetworkInfo {
  return {
    id: spec.id,
    identity: spec.genesis,
    testnet: spec.testnet,
    feeModel: 'utxo',
    finality: { kind: 'confirmations', confirmations: 6 },
    defaultConfirmations: 1,
    reorgWindow: 24,
    ...(spec.maxLagBlocks !== undefined ? { maxLagBlocks: spec.maxLagBlocks } : {}),
    ...(spec.explorer !== undefined
      ? {
          explorer: {
            tx: `${spec.explorer}/tx/{id}`,
            address: `${spec.explorer}/address/{address}`,
          },
        }
      : {}),
    params: {
      bech32: spec.bech32,
      pubKeyHash: spec.pubKeyHash,
      scriptHash: spec.scriptHash,
      dustRelayFee: 3_000n,
      minRelayFee: 1_000n,
      incrementalRelayFee: 1_000n,
      ...(spec.feeFallback !== undefined ? { feeFallback: spec.feeFallback } : {}),
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** R56: deep-frozen, so no caller can change a network another handle uses. */
export const BITCOIN_CHAIN: ChainInfo = deepFreeze({
  id: 'bitcoin',
  family: 'utxo',
  model: 'utxo',
  ordering: 'inputs',
  // keys[0] (the ECDSA key) defines the address; p2tr wallets also sign with Schnorr.
  schemes: ['secp256k1-ecdsa', 'secp256k1-schnorr'],
  nativeAsset: { symbol: 'BTC', decimals: 8, name: 'Bitcoin' },
  defaultNetwork: 'mainnet',
  networks: Object.fromEntries(NETWORKS.map((spec) => [spec.id, network(spec)])),
});
