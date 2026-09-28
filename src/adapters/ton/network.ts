/**
 * What the TON driver needs from a network's registry entry, validated once when a driver
 * is created, so inconsistent data fails with `CONFIG_INVALID` instead of misbehaving (M3).
 * SDK-free.
 */
import { ConfigError } from '../../core/errors/error';
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { MAX_COINS } from './fees';

/** The TON manifest's capabilities (spec §15); `address-history` comes with the indexer. */
export const TON_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'batch-transfer',
  'expiry',
]);
export const TON_INDEXER_CAPABILITIES: readonly Capability[] = Object.freeze([
  'address-history',
]);
/** Never on TON: sharded (no block source), and no replace or cancel (spec §15). */
const FORBIDDEN: readonly Capability[] = ['block-scan', 'replace-fee', 'cancel'];

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
  readonly capabilities: ReadonlySet<Capability>;
}

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

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
  if (network.feeModel !== 'ton') fail(`fee model '${network.feeModel}' is not 'ton'`);
  if (network.finality.kind !== 'masterchain') {
    fail(`finality '${network.finality.kind}' is not 'masterchain'`);
  }
  const params = network.params ?? {};
  // Own keys only; an explicit `undefined` is absent, so the library default applies.
  const param = (key: string, fallback: unknown): unknown => {
    const value = Object.hasOwn(params, key) ? params[key] : undefined;
    return value === undefined ? fallback : value;
  };
  const validFor = param('validForSeconds', 60);
  if (!isIntegerIn(validFor, 10, 86_400)) {
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
  const capabilities = new Set<Capability>([
    ...TON_CAPABILITIES,
    ...TON_INDEXER_CAPABILITIES,
  ]);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  for (const c of FORBIDDEN) {
    if (capabilities.has(c)) fail(`'${c}' is not available on TON`);
  }
  return {
    globalId,
    testnet: network.testnet,
    validForSeconds: validFor as number,
    jettonAttached: attached as bigint,
    jettonForwardAmount: forward as bigint,
    finalitySkewBlocks: skew as number,
    capabilities,
  };
}
