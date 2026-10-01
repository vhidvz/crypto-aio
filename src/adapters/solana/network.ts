/**
 * What the Solana driver needs from a network's registry entry and the handle's options,
 * validated once when a driver is created, so inconsistent data or an unknown option fails
 * with `CONFIG_INVALID` instead of misbehaving (M3, lesson 10).
 */
import { ConfigError } from '../../core/errors/error';
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { unknownName } from '../../core/util/names';
import { MAX_PRICE_VARIANT } from './fees';
import { decodeBase58 } from './keys';

/** Every capability a Solana network has; a network may remove some. */
export const SOLANA_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'block-scan',
  'address-history',
  'expiry',
]);

/**
 * The highest compute-unit price a transfer signs unless the handle's `maxComputeUnitPrice`
 * option allows more: 10,000,000 micro-lamports per compute unit (F5-R9 (b)). A speed's
 * price comes from one endpoint's `getRecentPrioritizationFees` and its limit from one
 * endpoint's simulation (up to 1,400,000 units), so this operator bound is the only one no
 * node can raise. At the largest limit it caps a transfer's priority fee at 14,000,000
 * lamports (0.014 SOL).
 */
export const DEFAULT_MAX_COMPUTE_UNIT_PRICE = 10_000_000n;
const U64_MAX = 2n ** 64n - 1n;

export interface SolanaNetworkConfig {
  /** The genesis hash every endpoint must report (`getGenesisHash`). */
  readonly genesisHash: string;
  readonly capabilities: ReadonlySet<Capability>;
  /**
   * The largest compute-unit price a transfer signs, in micro-lamports per compute unit:
   * from 999 (the largest build variant, which a speed keeps at the bound) to 2^64 − 1.
   */
  readonly maxComputeUnitPrice: bigint;
}

/**
 * The only driver option (`HandleOptions.options`) the Solana driver reads. Any other key is
 * refused, so a typo, or another family's option such as Tron's `maxFeeLimit`, fails loudly
 * instead of leaving the default in place (lesson 10).
 */
const OPTION_KEYS: readonly string[] = Object.freeze(['maxComputeUnitPrice']);

/** A price bound: a bigint of micro-lamports per compute unit that leaves room for a variant. */
function priceBound(
  value: unknown,
  name: string,
  fail: (reason: string) => never,
): bigint {
  if (typeof value !== 'bigint' || value < MAX_PRICE_VARIANT || value > U64_MAX) {
    fail(
      `${name} must be a bigint of micro-lamports per compute unit from 999 to 2^64 − 1`,
    );
  }
  return value as bigint;
}

export function solanaNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
  options: Readonly<Record<string, unknown>> = {},
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
  // F3-R16: the refusal lists the accepted name and shows neither the caller's key, which
  // may be a pasted secret, nor its value.
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) {
      fail(unknownName('option', OPTION_KEYS));
    }
  }
  // F5-R9 (b), F4-R28's shape: the handle's option, else the network entry's own, else the
  // default. A network value is checked even where an option overrides it.
  const own = network.params?.maxComputeUnitPrice;
  const networkBound =
    own === undefined ? undefined : priceBound(own, 'params.maxComputeUnitPrice', fail);
  const maxComputeUnitPrice =
    options.maxComputeUnitPrice !== undefined
      ? priceBound(options.maxComputeUnitPrice, 'maxComputeUnitPrice', fail)
      : (networkBound ?? DEFAULT_MAX_COMPUTE_UNIT_PRICE);
  return { genesisHash: network.identity as string, capabilities, maxComputeUnitPrice };
}
