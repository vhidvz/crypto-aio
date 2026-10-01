/**
 * Built-in EVM chains and networks (spec §2). Every value is verified against the source
 * named in the Plan 2 appendix, or is a documented library policy:
 * - `defaultConfirmations: 1`: `waitForConfirmation` waits for inclusion by default;
 *   credit deposits on `final`.
 * - `reorgWindow: 128` and `fallbackConfirmations: 128`: the library's scanner window. The
 *   EVM driver never falls back from the `finalized` tag to confirmations.
 * - `maxLagBlocks`: about 60 seconds of blocks, only where the block time is verified.
 * - `replacement.minBumpPercent: 10`: the spec's default (geth's `--txpool.pricebump`).
 */
import type { KnownCapability } from '../../core/model/capability';
import type { ChainInfo, FinalityPolicy, NetworkInfo } from '../../core/model/chain';
import { deepFreeze } from '../../core/util/freeze';

const FINALIZED_TAG: FinalityPolicy = {
  kind: 'tag',
  tag: 'finalized',
  fallbackConfirmations: 128,
};

interface NetworkSpec {
  readonly id: string;
  readonly chainId: number;
  readonly testnet: boolean;
  readonly explorer?: string;
  readonly maxLagBlocks?: number;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface ChainSpec {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly feeModel: 'evm-1559' | 'evm-legacy';
  readonly finality?: FinalityPolicy;
  /** Network capabilities removed from the EVM manifests' list. */
  readonly remove?: readonly KnownCapability[];
  /** `false` on chains without a mempool to replace transactions in (Arbitrum). */
  readonly replacement?: boolean;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly networks: readonly NetworkSpec[];
}

function evmNetwork(chain: ChainSpec, spec: NetworkSpec): NetworkInfo {
  return {
    id: spec.id,
    identity: String(spec.chainId),
    testnet: spec.testnet,
    feeModel: chain.feeModel,
    finality: chain.finality ?? FINALIZED_TAG,
    defaultConfirmations: 1,
    reorgWindow: 128,
    ...(spec.maxLagBlocks !== undefined ? { maxLagBlocks: spec.maxLagBlocks } : {}),
    ...(spec.explorer !== undefined
      ? {
          explorer: {
            tx: `${spec.explorer}/tx/{id}`,
            address: `${spec.explorer}/address/{address}`,
          },
        }
      : {}),
    ...(chain.replacement === false ? {} : { replacement: { minBumpPercent: 10 } }),
    ...(chain.remove ? { capabilities: { remove: chain.remove } } : {}),
    ...(chain.params || spec.params
      ? { params: { ...chain.params, ...spec.params } }
      : {}),
  };
}

function evmChain(spec: ChainSpec): ChainInfo {
  return {
    id: spec.id,
    family: 'evm',
    model: 'account',
    ordering: 'nonce',
    schemes: ['secp256k1-ecdsa'],
    nativeAsset: { symbol: spec.symbol, decimals: 18, name: spec.name },
    defaultNetwork: 'mainnet',
    networks: Object.fromEntries(spec.networks.map((n) => [n.id, evmNetwork(spec, n)])),
  };
}

const OP_STACK = { l1DataFee: 'op-stack' } as const;

/**
 * Frozen all the way down, as `BUILTIN_SCHEMES` is: networks share `FINALIZED_TAG`, and a
 * chain's networks share its `remove` list, so no caller may change them.
 */
export const EVM_CHAINS: readonly ChainInfo[] = deepFreeze([
  evmChain({
    id: 'ethereum',
    symbol: 'ETH',
    name: 'Ether',
    feeModel: 'evm-1559',
    networks: [
      { id: 'mainnet', chainId: 1, testnet: false, explorer: 'https://etherscan.io' },
      {
        id: 'sepolia',
        chainId: 11155111,
        testnet: true,
        explorer: 'https://sepolia.etherscan.io',
      },
      {
        id: 'hoodi',
        chainId: 560048,
        testnet: true,
        explorer: 'https://hoodi.etherscan.io',
      },
    ],
  }),
  evmChain({
    id: 'bsc',
    symbol: 'BNB',
    name: 'BNB',
    // BEP-226: type-2 transactions are accepted, but the base fee is always 0.
    feeModel: 'evm-legacy',
    remove: ['fee-market-1559'],
    networks: [
      {
        id: 'mainnet',
        chainId: 56,
        testnet: false,
        explorer: 'https://bscscan.com',
        maxLagBlocks: 134,
      },
      {
        id: 'testnet',
        chainId: 97,
        testnet: true,
        explorer: 'https://testnet.bscscan.com',
      },
    ],
  }),
  evmChain({
    id: 'polygon',
    symbol: 'POL',
    name: 'POL',
    feeModel: 'evm-1559',
    // bor, Polygon PoS's client, adds system logs to receipts (R69, R70).
    params: { systemLogs: 'bor' },
    networks: [
      {
        id: 'mainnet',
        chainId: 137,
        testnet: false,
        explorer: 'https://polygonscan.com',
        // The Polygon Gas Station docs: mainnet requires a 25 gwei priority fee.
        params: { minPriorityFeePerGas: 25_000_000_000n },
      },
      {
        id: 'amoy',
        chainId: 80002,
        testnet: true,
        explorer: 'https://amoy.polygonscan.com',
      },
    ],
  }),
  evmChain({
    id: 'avalanche',
    symbol: 'AVAX',
    name: 'Avalanche',
    feeModel: 'evm-1559',
    // The C-Chain's `latest` block is final (accepted); it has no deeper finality to wait for.
    finality: { kind: 'confirmations', confirmations: 1 },
    remove: ['finality-tag'],
    networks: [
      { id: 'mainnet', chainId: 43114, testnet: false },
      { id: 'fuji', chainId: 43113, testnet: true },
    ],
  }),
  evmChain({
    id: 'arbitrum',
    symbol: 'ETH',
    name: 'Ether',
    feeModel: 'evm-1559',
    // No mempool: the sequencer runs transactions first come, first served.
    replacement: false,
    remove: ['replace-fee', 'cancel'],
    networks: [
      {
        id: 'mainnet',
        chainId: 42161,
        testnet: false,
        explorer: 'https://arbiscan.io',
        maxLagBlocks: 240,
      },
      {
        id: 'sepolia',
        chainId: 421614,
        testnet: true,
        explorer: 'https://sepolia.arbiscan.io',
      },
    ],
  }),
  evmChain({
    id: 'optimism',
    symbol: 'ETH',
    name: 'Ether',
    feeModel: 'evm-1559',
    params: OP_STACK,
    networks: [
      {
        id: 'mainnet',
        chainId: 10,
        testnet: false,
        explorer: 'https://explorer.optimism.io',
        maxLagBlocks: 30,
      },
      {
        id: 'sepolia',
        chainId: 11155420,
        testnet: true,
        explorer: 'https://testnet-explorer.optimism.io',
      },
    ],
  }),
  evmChain({
    id: 'base',
    symbol: 'ETH',
    name: 'Ether',
    feeModel: 'evm-1559',
    params: OP_STACK,
    networks: [
      {
        id: 'mainnet',
        chainId: 8453,
        testnet: false,
        explorer: 'https://basescan.org',
        maxLagBlocks: 30,
      },
      {
        id: 'sepolia',
        chainId: 84532,
        testnet: true,
        explorer: 'https://sepolia.basescan.org',
      },
    ],
  }),
]);
