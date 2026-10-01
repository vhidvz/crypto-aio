/**
 * Well-known tokens: USDT and USDC where their issuers deploy them natively on
 * a built-in mainnet (Tether's supported-protocols page, Circle's USDC addresses page).
 * Addresses are EIP-55 checksummed; decimals are verified on each chain's explorer.
 */
import type { AssetRegistration } from '../../core/registry/assets';

function token(
  chain: string,
  symbol: 'USDT' | 'USDC',
  contract: string,
): AssetRegistration {
  return {
    chain,
    network: 'mainnet',
    ref: { standard: 'erc20', contract },
    metadata: { symbol, decimals: 6 },
    aliases: [symbol],
  };
}

export const EVM_TOKENS: readonly AssetRegistration[] = [
  token('ethereum', 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  token('ethereum', 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  token('avalanche', 'USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'),
  token('avalanche', 'USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
  token('polygon', 'USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
  token('arbitrum', 'USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
  token('optimism', 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
  token('base', 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
];
