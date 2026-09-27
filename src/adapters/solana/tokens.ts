/**
 * Well-known SPL tokens (spec §6.2): USDC and USDT where their issuers list a Solana mint
 * (Circle's USDC addresses page, Tether's supported-protocols page). All are classic Token
 * program mints with 6 decimals, read from the chain (Plan 5 appendix).
 */
import type { AssetRegistration } from '../../core/registry/assets';
import { deepFreeze } from './chains';

function token(
  network: 'mainnet' | 'devnet',
  symbol: 'USDC' | 'USDT',
  mint: string,
): AssetRegistration {
  return {
    chain: 'solana',
    network,
    ref: { standard: 'spl', contract: mint },
    metadata: { symbol, decimals: 6 },
    aliases: [symbol],
  };
}

export const SOLANA_TOKENS: readonly AssetRegistration[] = deepFreeze([
  token('mainnet', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  token('mainnet', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  token('devnet', 'USDC', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
]);
