/**
 * What the UTXO driver needs from a network's registry entry and from the handle's
 * `options`, validated once when a driver is created, so bad data fails with
 * `CONFIG_INVALID` instead of misbehaving (every number is checked, and the finality
 * depth is a safe integer of at least 1).
 */
import { ConfigError } from '../../core/errors/error';
import { KNOWN_CAPABILITIES, type Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { unknownName } from '../../core/util/names';
import type { AddressParams } from './types';

/** Every capability of a UTXO network (the indexer is required). */
export const UTXO_CAPABILITIES: readonly Capability[] = Object.freeze([
  'batch-transfer',
  'replace-fee',
  'cancel',
  'block-scan',
  'address-history',
  'hd-public-derivation',
]);

export type CoinSelectionStrategy = 'accumulative' | 'all';

export interface UtxoNetworkConfig {
  /** The genesis block hash: the endpoint identity. */
  readonly genesisHash: string;
  readonly address: AddressParams;
  /** Finality depth N: a block with N confirmations is final. */
  readonly confirmations: number;
  /** Relay policy, in sat/kvB. */
  readonly dustRelayFee: bigint;
  readonly minRelayFee: bigint;
  readonly incrementalRelayFee: bigint;
  /** The rate used when a test network's estimator has no data; `undefined` on mainnet. */
  readonly feeFallback?: bigint;
  /** Absurd-fee guard: the highest fee rate (sat/kvB) and absolute fee (sat) ever built. */
  readonly maxFeeRate: bigint;
  readonly maxFee: bigint;
  /**
   * The highest rate (sat/kvB) taken from an endpoint's estimate; above it the estimate
   * decides nothing. One endpoint's estimate sets a speed's rate, so it has a cap of its
   * own, lower than `maxFeeRate`, which alone bounds an explicit override.
   */
  readonly maxEstimatedFeeRate: bigint;
  /**
   * Carry each segwit v0 input's previous transaction in the PSBT, for hardware wallets
   * that demand it. A p2tr input never carries one.
   */
  readonly nonWitnessUtxo: boolean;
  /** Confirmations an output needs before coin selection spends it (0 allows unconfirmed). */
  readonly minInputConfirmations: number;
  readonly coinSelection: CoinSelectionStrategy;
  /** Signal BIP125 replaceability (`nSequence` 0xfffffffd) on every input. */
  readonly rbf: boolean;
  readonly capabilities: ReadonlySet<Capability>;
}

/** Library defaults for the handle `options`: library policy, not network facts. */
export const OPTION_DEFAULTS = Object.freeze({
  maxFeeRate: 1_000_000n, // 1,000 sat/vB
  maxFee: 10_000_000n, // 0.1 BTC, Bitcoin Core's -maxtxfee default
  maxEstimatedFeeRate: 200_000n, // 200 sat/vB
  nonWitnessUtxo: true,
  minInputConfirmations: 1,
  coinSelection: 'accumulative' as CoinSelectionStrategy,
  rbf: true,
});

const OPTION_KEYS = new Set([
  'maxFeeRate',
  'maxFee',
  'maxEstimatedFeeRate',
  'nonWitnessUtxo',
  'minInputConfirmations',
  'coinSelection',
  'rbf',
]);

/**
 * A network's capability overrides, checked against what the
 * UTXO driver serves. The handle advertises the manifest's capabilities plus `add`, minus
 * `remove`, and the core accepts what it advertises: `add: ['memo']` would make it take a
 * memo the builder cannot write (no OP_RETURN). So each name, added or removed, must be one
 * the driver serves, and a removal of anything else fails as the typo it likely is. The error
 * names a library capability, never a caller's unknown text, and lists the accepted names.
 */
function checkCapabilities(network: NetworkInfo, fail: (reason: string) => never): void {
  const add: unknown = network.capabilities?.add ?? [];
  const remove: unknown = network.capabilities?.remove ?? [];
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    fail('capabilities.add and capabilities.remove must be lists');
  }
  const serves = `the UTXO driver serves ${UTXO_CAPABILITIES.join(', ')}`;
  for (const [side, names] of [
    ['add', add],
    ['remove', remove],
  ] as const) {
    for (const name of names as readonly unknown[]) {
      if (UTXO_CAPABILITIES.includes(name as Capability)) continue;
      const known = (KNOWN_CAPABILITIES as readonly unknown[]).includes(name);
      fail(
        `capabilities.${side}: ${known ? `'${String(name)}' is not one` : 'an unknown name'}; ${serves}`,
      );
    }
  }
}

export function utxoNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
  options: Readonly<Record<string, unknown>> = {},
): UtxoNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `UTXO network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  const identity = network.identity;
  if (identity === undefined || !/^[0-9a-f]{64}$/.test(identity)) {
    fail('its identity must be the genesis block hash (64 lowercase hex digits)');
  }
  if (network.feeModel !== 'utxo') fail(`fee model '${network.feeModel}' is not 'utxo'`);
  const finality = network.finality;
  if (finality.kind !== 'confirmations') {
    fail(`finality '${finality.kind}' is not a UTXO policy (use 'confirmations')`);
  }
  const confirmations = (finality as { confirmations: unknown }).confirmations;
  if (!Number.isSafeInteger(confirmations) || (confirmations as number) < 1) {
    fail('finality.confirmations must be a safe integer >= 1');
  }
  const params = network.params ?? {};
  const bech32 = params.bech32;
  // 30 letters at most: a 32-byte witness program (p2tr, p2wsh) then fits in 90 characters.
  if (typeof bech32 !== 'string' || !/^[a-z]{1,30}$/.test(bech32)) {
    fail('params.bech32 must be a lowercase human-readable part of 1 to 30 letters');
  }
  const byte = (key: string): number => {
    const value = params[key];
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
      fail(`params.${key} must be a byte (0-255)`);
    }
    return value as number;
  };
  const pubKeyHash = byte('pubKeyHash');
  const scriptHash = byte('scriptHash');
  if (pubKeyHash === scriptHash) fail('params.pubKeyHash and scriptHash must differ');
  const rate = (
    source: Readonly<Record<string, unknown>>,
    key: string,
    where: string,
  ) => {
    const value = source[key];
    if (typeof value !== 'bigint' || value < 0n)
      fail(`${where}.${key} must be a bigint >= 0`);
    return value as bigint;
  };
  const dustRelayFee = rate(params, 'dustRelayFee', 'params');
  const minRelayFee = rate(params, 'minRelayFee', 'params');
  const incrementalRelayFee = rate(params, 'incrementalRelayFee', 'params');
  const feeFallback =
    params.feeFallback === undefined ? undefined : rate(params, 'feeFallback', 'params');

  for (const key of Object.keys(options)) {
    // The accepted names, never the caller's key (it may be a pasted secret).
    if (!OPTION_KEYS.has(key)) fail(unknownName('option', OPTION_KEYS));
  }
  const merged = { ...OPTION_DEFAULTS, ...options };
  const maxFeeRate = rate(merged, 'maxFeeRate', 'options');
  const maxFee = rate(merged, 'maxFee', 'options');
  if (maxFeeRate < minRelayFee) fail('options.maxFeeRate is below the minimum relay fee');
  if (maxFee < 1n) fail('options.maxFee must be at least 1 satoshi');
  const maxEstimatedFeeRate = rate(merged, 'maxEstimatedFeeRate', 'options');
  if (maxEstimatedFeeRate < minRelayFee) {
    fail('options.maxEstimatedFeeRate is below the minimum relay fee');
  }
  if (typeof merged.nonWitnessUtxo !== 'boolean')
    fail('options.nonWitnessUtxo must be a boolean');
  const minInputConfirmations = merged.minInputConfirmations;
  if (!Number.isSafeInteger(minInputConfirmations) || minInputConfirmations < 0) {
    fail('options.minInputConfirmations must be a safe integer >= 0');
  }
  if (merged.coinSelection !== 'accumulative' && merged.coinSelection !== 'all') {
    fail(`options.coinSelection must be 'accumulative' or 'all'`);
  }
  if (typeof merged.rbf !== 'boolean') fail('options.rbf must be a boolean');

  checkCapabilities(network, fail);
  const capabilities = new Set<Capability>(UTXO_CAPABILITIES);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  return {
    genesisHash: identity as string,
    address: { bech32: bech32 as string, pubKeyHash, scriptHash },
    confirmations: confirmations as number,
    dustRelayFee,
    minRelayFee,
    incrementalRelayFee,
    ...(feeFallback !== undefined ? { feeFallback } : {}),
    maxFeeRate,
    maxFee,
    maxEstimatedFeeRate,
    nonWitnessUtxo: merged.nonWitnessUtxo,
    minInputConfirmations,
    coinSelection: merged.coinSelection,
    rbf: merged.rbf,
    capabilities,
  };
}
