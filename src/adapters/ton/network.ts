/**
 * What the TON driver needs from a network's registry entry, validated once when a driver
 * is created, so inconsistent data fails with `CONFIG_INVALID` instead of misbehaving (M3).
 * SDK-free.
 */
import { ConfigError } from '../../core/errors/error';
import { KNOWN_CAPABILITIES, type Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { MAX_COINS } from './fees';

/**
 * The TON manifest's capabilities (spec §15); `address-history` comes with the indexer. No
 * `batch-transfer` (Task 9): the verdict answers `failed` for a partly delivered batch, and
 * a failed Operation sent again whole would pay twice the outputs that moved, so a TON
 * transfer carries exactly one output.
 */
export const TON_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'expiry',
]);
export const TON_INDEXER_CAPABILITIES: readonly Capability[] = Object.freeze([
  'address-history',
]);
/**
 * The only capabilities a TON network may add or remove (M2). Never on TON: `block-scan`
 * (sharded, no block source), `replace-fee` and `cancel` (spec §15), `batch-transfer` (one
 * output per transfer, Task 9), nor any other.
 */
const OWN_CAPABILITIES: ReadonlySet<Capability> = new Set([
  ...TON_CAPABILITIES,
  ...TON_INDEXER_CAPABILITIES,
]);

/** The TON network options (`NetworkInfo.params`); any other key is a typo (M2). */
const OPTIONS: ReadonlySet<string> = new Set([
  'validForSeconds',
  'jettonAttached',
  'jettonForwardAmount',
  'finalitySkewBlocks',
  'maxNetworkFee',
]);

/** The ceiling of each workchain's `network` charge, in nanograms. */
export interface TonFeeCeiling {
  readonly basechain: bigint;
  readonly masterchain: bigint;
}

/**
 * The default economic ceiling on the `network` charge an endpoint's emulation suggests
 * (board: "economic ceilings on fees taken from a node"; F6-R16, F6-R17), which a network
 * replaces with `params.maxNetworkFee`. TON signs no fee: the chain charges gas and forward
 * fees by its config, so an inflated estimate cannot make a transfer pay more, but it would
 * fail the funds check for good (`INSUFFICIENT_FUNDS`) or mislead whoever approves the fee.
 * A basechain wallet's transfer costs about 0.001-0.01 TON, and a whole gas limit (1M gas at
 * 400 nanograms) 0.4 TON; a masterchain wallet pays about 25 times the gas and far more
 * storage (about 6 TON a year for a v4r2 wallet at mainnet's config param 18), so 100 TON
 * refuses only a wallet idle for more than about 13 years. Above the ceiling an estimate is
 * a retryable `PROVIDER_INCONSISTENT`.
 */
export const DEFAULT_MAX_NETWORK_FEE: TonFeeCeiling = Object.freeze({
  basechain: 1_000_000_000n,
  masterchain: 100_000_000_000n,
});

const WORKCHAINS: ReadonlySet<string> = new Set(['basechain', 'masterchain']);

/**
 * A capability as an error may show it (F3-R16): a core capability's name is a fixed word, so
 * it is shown; any other text could be a pasted secret, so it is not. Unknown option keys are
 * never echoed either; their errors list the accepted names instead.
 */
const shown = (capability: Capability): string =>
  (KNOWN_CAPABILITIES as readonly string[]).includes(capability)
    ? `'${capability}'`
    : 'an unknown capability';

export interface TonNetworkConfig {
  /** Config param 19; the network identity. */
  readonly globalId: number;
  readonly testnet: boolean;
  /** A message's lifetime past chain time, in seconds. */
  readonly validForSeconds: number;
  /** Nanograms attached to each jetton wallet message; the unspent part is refunded. */
  readonly jettonAttached: bigint;
  /** Nanograms forwarded with each jetton notification. */
  readonly jettonForwardAmount: bigint;
  /** Masterchain blocks the attested head first trails the freshest endpoint by (M1). */
  readonly finalitySkewBlocks: number;
  /** The most an estimate's `network` charge may be, per workchain of the sender. */
  readonly maxNetworkFee: TonFeeCeiling;
  readonly capabilities: ReadonlySet<Capability>;
}

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** The lifetimes a network may configure (`params.validForSeconds`), in seconds. */
export const MIN_VALID_FOR_SECONDS = 10;
export const MAX_VALID_FOR_SECONDS = 86_400;

/** How far an endpoint's `sync_utime` may be from the local clock (M3), in seconds. */
export const CHAIN_TIME_TOLERANCE = 300;

/**
 * F6-R29: a build's recorded chain time (`TonSeqnoOrdering.validFrom`) when the ordering holds
 * a well-formed one for its lifetime: a safe integer at least the shortest lifetime before
 * `validUntil`, and at most the longest (plus the chain-time tolerance) before it. Undefined
 * otherwise (an attempt built before the field existed, or a damaged record).
 */
export function recordedValidFrom(slot: {
  readonly validUntil: number;
}): number | undefined {
  const { validUntil } = slot;
  const { validFrom } = slot as { readonly validFrom?: unknown };
  return typeof validFrom === 'number' &&
    Number.isSafeInteger(validFrom) &&
    validFrom <= validUntil - MIN_VALID_FOR_SECONDS &&
    validFrom >= validUntil - MAX_VALID_FOR_SECONDS - CHAIN_TIME_TOLERANCE
    ? validFrom
    : undefined;
}

export function tonNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
): TonNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `TON network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  const identity = network.identity;
  if (identity === undefined || !/^-?[1-9][0-9]*$/.test(identity)) {
    fail('its identity must be the decimal global id (config param 19)');
  }
  const globalId = Number(identity);
  if (!isIntegerIn(globalId, -(2 ** 31), 2 ** 31 - 1)) {
    fail('the global id must be an int32');
  }
  if (network.feeModel !== 'ton') {
    fail(`its fee model must be 'ton'`);
  }
  if (network.finality.kind !== 'masterchain') {
    fail(`its finality must be 'masterchain'`);
  }
  const params = network.params ?? {};
  for (const key of Object.keys(params)) {
    if (!OPTIONS.has(key)) {
      fail(
        `params has a key that is not a TON network option (${[...OPTIONS].join(', ')})`,
      );
    }
  }
  // Own keys only; an explicit `undefined` is absent, so the library default applies.
  const param = (key: string, fallback: unknown): unknown => {
    const value = Object.hasOwn(params, key) ? params[key] : undefined;
    return value === undefined ? fallback : value;
  };
  const validFor = param('validForSeconds', 60);
  if (!isIntegerIn(validFor, MIN_VALID_FOR_SECONDS, MAX_VALID_FOR_SECONDS)) {
    fail('params.validForSeconds must be an integer in [10, 86400]');
  }
  // Encoded as Coins in every jetton wallet message (lesson 19).
  const attached = param('jettonAttached', 50_000_000n);
  if (typeof attached !== 'bigint' || attached <= 0n || attached > MAX_COINS) {
    fail('params.jettonAttached must be a bigint in [1, 2^120 - 1] (nanograms)');
  }
  const forward = param('jettonForwardAmount', 1n);
  if (typeof forward !== 'bigint' || forward < 0n || forward >= (attached as bigint)) {
    fail('params.jettonForwardAmount must be a bigint in [0, jettonAttached)');
  }
  const skew = param('finalitySkewBlocks', 10);
  if (!isIntegerIn(skew, 1, 1_000)) {
    fail('params.finalitySkewBlocks must be an integer in [1, 1000]');
  }
  const maxNetworkFee = feeCeiling(param('maxNetworkFee', {}), fail);
  const capabilities = new Set<Capability>([
    ...TON_CAPABILITIES,
    ...TON_INDEXER_CAPABILITIES,
  ]);
  const own = (c: Capability): Capability =>
    OWN_CAPABILITIES.has(c) ? c : fail(`${shown(c)} is not available on TON`);
  for (const c of network.capabilities?.add ?? []) capabilities.add(own(c));
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(own(c));
  return {
    globalId,
    testnet: network.testnet,
    validForSeconds: validFor as number,
    jettonAttached: attached as bigint,
    jettonForwardAmount: forward as bigint,
    finalitySkewBlocks: skew as number,
    maxNetworkFee,
    capabilities,
  };
}

/**
 * `params.maxNetworkFee`: `{ basechain?, masterchain? }`, each a positive bigint within Coins
 * (the charge is compared with nanogram amounts); a workchain left out keeps its default.
 * Any other key, or value, is `CONFIG_INVALID`, which never echoes the key (M2, F3-R16).
 */
function feeCeiling(value: unknown, fail: (reason: string) => never): TonFeeCeiling {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('params.maxNetworkFee must be { basechain?, masterchain? } (nanograms)');
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (!WORKCHAINS.has(key)) {
      fail(`params.maxNetworkFee takes only 'basechain' and 'masterchain'`);
    }
  }
  const bound = (key: keyof TonFeeCeiling): bigint => {
    const own = Object.hasOwn(record, key) ? record[key] : undefined;
    const ceiling = own === undefined ? DEFAULT_MAX_NETWORK_FEE[key] : own;
    if (typeof ceiling !== 'bigint' || ceiling <= 0n || ceiling > MAX_COINS) {
      fail(`params.maxNetworkFee.${key} must be a bigint in [1, 2^120 - 1] (nanograms)`);
    }
    return ceiling as bigint;
  };
  return Object.freeze({
    basechain: bound('basechain'),
    masterchain: bound('masterchain'),
  });
}
