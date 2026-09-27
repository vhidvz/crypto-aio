/**
 * Well-known tokens (spec §6.2): USDT, which Tether deploys natively on Tron mainnet
 * (Tether's supported-protocols page); decimals and symbol read from the contract. Circle
 * lists no Tron USDC, so there is none. The contract is the base58 form, the canonical one.
 */
import type { AssetRegistration } from '../../core/registry/assets';
import { deepFreeze } from './chains';

export const TRON_TOKENS: readonly AssetRegistration[] = deepFreeze([
  {
    chain: 'tron',
    network: 'mainnet',
    ref: { standard: 'trc20', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    metadata: { symbol: 'USDT', decimals: 6 },
    aliases: ['USDT'],
  },
]);
