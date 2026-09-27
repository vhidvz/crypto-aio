/**
 * What the Tron driver needs from a network's registry entry and the handle's options,
 * validated once when a driver is created (M3, lesson 10): a custom network or option with
 * inconsistent data fails with `CONFIG_INVALID` instead of misbehaving.
 */
import { ConfigError } from '../../core/errors/error';
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';

/** Every capability of the Tron driver; `address-history` comes with an indexer. */
export const TRON_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'block-scan',
  'hd-public-derivation',
  'expiry',
]);
export const TRON_INDEXER_CAPABILITIES: readonly Capability[] = Object.freeze([
  'address-history',
]);

export const DEFAULT_EXPIRATION_MS = 60_000;
export const MIN_EXPIRATION_MS = 10_000;
/**
 * The longest expiration window this driver builds (D3). The negative inclusion proof scans
 * every block that could hold a transaction built with any window up to this one, so it may
 * only ever grow; shrinking it would let a proof miss an inclusion.
 */
export const MAX_EXPIRATION_MS = 300_000;
export const DEFAULT_ENERGY_MARGIN_PERCENT = 20;
/** Memo bytes (UTF-8) accepted in `raw_data.data` (D9). */
export const MAX_MEMO_BYTES = 256;

export interface TronNetworkConfig {
  /** The id of block 0, which the identity probe compares. */
  readonly identity: string;
  readonly expirationMs: number;
  readonly energyMarginPercent: number;
}

/**
 * The only driver options (`HandleOptions.options`) the Tron driver reads. Any other key is
 * refused, so a typo such as `expirationMS` fails loudly instead of leaving the default in
 * place (lesson 10).
 */
const OPTION_KEYS: ReadonlySet<string> = new Set(['expirationMs', 'energyMarginPercent']);

function integerIn(
  value: unknown,
  min: number,
  max: number,
  name: string,
  fail: (reason: string) => never,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    fail(`${name} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

export function tronNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
  options: Readonly<Record<string, unknown>> = {},
): TronNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Tron network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  if (chain.family !== 'tron' || chain.ordering !== 'expiry') {
    fail(`the chain must be of family 'tron' with 'expiry' ordering`);
  }
  if (network.identity === undefined || !/^[0-9a-f]{64}$/.test(network.identity)) {
    fail('its identity must be the id of block 0 (64 lower-case hex digits)');
  }
  if (network.feeModel !== 'tron') fail(`its fee model must be 'tron'`);
  if (network.finality.kind !== 'solidified') fail(`its finality must be 'solidified'`);
  // The error names the key only, never its value.
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(`unknown option '${key}'`);
  }
  return {
    identity: network.identity as string,
    expirationMs:
      options.expirationMs === undefined
        ? DEFAULT_EXPIRATION_MS
        : integerIn(
            options.expirationMs,
            MIN_EXPIRATION_MS,
            MAX_EXPIRATION_MS,
            'expirationMs',
            fail,
          ),
    energyMarginPercent:
      options.energyMarginPercent === undefined
        ? DEFAULT_ENERGY_MARGIN_PERCENT
        : integerIn(options.energyMarginPercent, 0, 1_000, 'energyMarginPercent', fail),
  };
}
