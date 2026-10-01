/**
 * What the Tron driver needs from a network's registry entry and the handle's options,
 * validated once when a driver is created (M3, lesson 10): a custom network or option with
 * inconsistent data fails with `CONFIG_INVALID` instead of misbehaving.
 */
import { ConfigError } from '../../core/errors/error';
import { KNOWN_CAPABILITIES, type Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { knownName, unknownName } from '../../core/util/names';

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
 * The longest expiration window this driver builds (D3). The negative inclusion proof does
 * not depend on it: it scans from the reference block to the signed expiration (F4-R12).
 */
export const MAX_EXPIRATION_MS = 300_000;
/**
 * TaPoS (java-tron GreatVoyage-v4.8.2.2 `d5c3d1d1`, `Manager.validateTapos` and
 * `updateRecentBlock`): a transaction's reference block must be the one the recent-block
 * store holds under its number's bytes 6..8, and each block overwrites the entry of the block
 * 65,536 below it. So only the 65,536 blocks after the reference block can hold the
 * transaction, and an Attempt's `lastValidHeight` is its reference height plus this window.
 */
export const TAPOS_WINDOW = 65_536n;
export const DEFAULT_ENERGY_MARGIN_PERCENT = 20;
/**
 * The largest fee limit a TRC-20 transfer carries unless the handle's `maxFeeLimit` option
 * allows more: 100 TRX, in sun (F4-R28). The network's own maximum (`getMaxFeeLimit`, 15,000
 * TRX on mainnet), the energy price and the simulated energy all come from one endpoint's
 * answer, and a call that fails through an INVALID opcode (a Solidity `assert`) burns its
 * whole fee limit, so this operator bound is the only one no node can raise. It covers a
 * TRC-20 transfer to a new holder (about 130,000 energy) at 420 sun per energy, margin
 * included.
 */
export const DEFAULT_MAX_FEE_LIMIT = 100_000_000n;
/** The largest `fee_limit` the codec writes exactly (lesson 19): 2^53 − 1 sun. */
export const MAX_ENCODABLE_FEE_LIMIT = BigInt(Number.MAX_SAFE_INTEGER);
/** Memo bytes (UTF-8) accepted in `raw_data.data` (D9). */
export const MAX_MEMO_BYTES = 256;

export interface TronNetworkConfig {
  /** The id of block 0, which the identity probe compares. */
  readonly identity: string;
  readonly expirationMs: number;
  readonly energyMarginPercent: number;
  /** The largest fee limit a transfer may carry, in sun: from 1 to 2^53 − 1 (F4-R28). */
  readonly maxFeeLimit: bigint;
}

/**
 * The only driver options (`HandleOptions.options`) the Tron driver reads. Any other key is
 * refused, so a typo such as `expirationMS` fails loudly instead of leaving the default in
 * place (lesson 10).
 */
const OPTION_KEYS: readonly string[] = Object.freeze([
  'expirationMs',
  'energyMarginPercent',
  'maxFeeLimit',
]);
/**
 * A capability from the network entry as an error may show it (F3-R16): a core capability's
 * name is a fixed word, so it is shown; any other text could be a pasted secret, so it is not.
 */
const named = (key: unknown): string =>
  knownName(key, KNOWN_CAPABILITIES, 'an unknown capability');

/**
 * F4-R2 M3: a network's capability overrides, checked against what the Tron driver serves,
 * as `evmNetworkConfig` checks the EVM ones. The handle advertises the manifest's
 * capabilities plus `add`, minus `remove` (the core's order), so that set must stay within
 * the driver's own: no `replace-fee` or `cancel` (no replacement), no `fee-market-1559` (the
 * `tron` fee model), no `finality-tag` (solidified finality), no `batch-transfer`.
 * `address-history` comes with an indexer, never from the network, and `expiry` is how every
 * Tron transaction is ordered. A removal must name a Tron capability, so a typo fails instead
 * of leaving the capability advertised (lesson 10).
 */
function checkCapabilities(network: NetworkInfo, fail: (reason: string) => never): void {
  const add: unknown = network.capabilities?.add ?? [];
  const remove: unknown = network.capabilities?.remove ?? [];
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    return fail('capabilities.add and capabilities.remove must be lists');
  }
  const own = (list: readonly Capability[], c: unknown) => list.includes(c as Capability);
  const advertised = new Set<unknown>([...TRON_CAPABILITIES, ...add]);
  for (const c of remove) {
    if (!own(TRON_CAPABILITIES, c) && !own(TRON_INDEXER_CAPABILITIES, c)) {
      fail(`capabilities.remove: the Tron driver does not have ${named(c)}`);
    }
    advertised.delete(c);
  }
  for (const c of advertised) {
    if (own(TRON_INDEXER_CAPABILITIES, c)) {
      fail(`capabilities.add: ${named(c)} comes with an indexer, never from the network`);
    }
    if (!own(TRON_CAPABILITIES, c)) {
      fail(`capabilities.add: the Tron driver does not have ${named(c)}`);
    }
  }
  if (!advertised.has('expiry')) {
    fail(`capabilities.remove: every Tron transaction expires, so 'expiry' stays`);
  }
}

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

/** A fee-limit bound: a bigint of sun from 1 to what the codec writes exactly (lesson 19). */
function feeLimitBound(
  value: unknown,
  name: string,
  fail: (reason: string) => never,
): bigint {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_ENCODABLE_FEE_LIMIT) {
    fail(`${name} must be a bigint of sun from 1 to 2^53 − 1`);
  }
  return value as bigint;
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
  checkCapabilities(network, fail);
  // F3-R16: the refusal lists the accepted names and shows neither the caller's key, which
  // may be a pasted secret, nor its value.
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) {
      fail(unknownName('option', OPTION_KEYS));
    }
  }
  // F4-R28: the handle's option, else the network entry's own, else 100 TRX. A network
  // value is checked even where an option overrides it, so a bad entry fails loudly.
  const ownBound = network.params?.maxFeeLimit;
  const networkBound =
    ownBound === undefined
      ? undefined
      : feeLimitBound(ownBound, 'params.maxFeeLimit', fail);
  const maxFeeLimit =
    options.maxFeeLimit !== undefined
      ? feeLimitBound(options.maxFeeLimit, 'maxFeeLimit', fail)
      : (networkBound ?? DEFAULT_MAX_FEE_LIMIT);
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
    maxFeeLimit,
  };
}
