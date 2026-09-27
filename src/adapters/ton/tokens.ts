/**
 * Well-known TON assets (spec §6.2). USDT is Tether's jetton on TON mainnet (master and
 * 6 decimals verified against docs.ton.org and the master's on-chain content). The native
 * coin keeps the alias `TON` beside its ticker `GRAM` (formerly Toncoin).
 * USDT's `name` ('Tether USD') is the master's on-chain jetton metadata name, not verified
 * live (it is not in the Plan 6 appendix).
 * Jetton asset ids use the master's raw address: `ton:mainnet/jetton:0:<hex>`.
 */
import type { AssetRegistration } from '../../core/registry/assets';
import { TON_CHAINS, deepFreeze } from './chains';

/** The alias `TON` on each network's native coin, with the chain's own metadata. */
const NATIVE_ALIASES: readonly AssetRegistration[] = TON_CHAINS.flatMap((chain) =>
  Object.keys(chain.networks).map((network) => ({
    chain: chain.id,
    network,
    ref: 'native',
    metadata: chain.nativeAsset,
    aliases: ['TON'],
  })),
);

export const TON_TOKENS: readonly AssetRegistration[] = deepFreeze([
  ...NATIVE_ALIASES,
  {
    chain: 'ton',
    network: 'mainnet',
    ref: {
      standard: 'jetton',
      contract: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
    },
    metadata: { symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    aliases: ['USDT'],
  },
]);
