/**
 * What the Solana driver needs from a network's registry entry, validated once when a
 * driver is created, so inconsistent data fails with `CONFIG_INVALID` instead of
 * misbehaving (M3).
 */
import { ConfigError } from '../../core/errors/error';
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { decodeBase58 } from './keys';

/** Every capability a Solana network has; a network may remove some. */
export const SOLANA_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'block-scan',
  'address-history',
  'expiry',
]);

export interface SolanaNetworkConfig {
  /** The genesis hash every endpoint must report (`getGenesisHash`). */
  readonly genesisHash: string;
  readonly capabilities: ReadonlySet<Capability>;
}

export function solanaNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
): SolanaNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Solana network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  if (chain.model !== 'account' || chain.ordering !== 'expiry') {
    fail('the chain must use the account model and expiry ordering');
  }
  if (chain.schemes.length !== 1 || chain.schemes[0] !== 'ed25519') {
    fail(`its only scheme must be 'ed25519'`);
  }
  if (chain.nativeAsset.decimals !== 9)
    fail('the native asset has 9 decimals (lamports)');
  if (decodeBase58(network.identity, 32) === null) {
    fail('its identity must be the base58 genesis hash');
  }
  if (network.feeModel !== 'solana') fail(`its fee model must be 'solana'`);
  const { finality } = network;
  if (finality.kind !== 'commitment' || finality.level !== 'finalized') {
    fail(`its finality must be the 'finalized' commitment`);
  }
  if (network.replacement !== undefined) fail('Solana has no replace or cancel');
  const capabilities = new Set<Capability>(SOLANA_CAPABILITIES);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  for (const c of ['replace-fee', 'cancel', 'batch-transfer'] as const) {
    if (capabilities.has(c)) fail(`the Solana driver cannot offer '${c}'`);
  }
  if (!capabilities.has('expiry')) fail(`'expiry' is how Solana orders transactions`);
  return { genesisHash: network.identity as string, capabilities };
}
