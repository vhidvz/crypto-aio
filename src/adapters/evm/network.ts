/**
 * What the EVM driver needs from a network's registry entry (spec §2: "each network keeps
 * its own registry identity"), validated once when a driver is created, so a custom EVM
 * chain with inconsistent data fails with `CONFIG_INVALID` instead of misbehaving.
 */
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, FinalityPolicy, NetworkInfo } from '../../core/model/chain';
import { ConfigError } from '../../core/errors/error';
import type { EvmFeeModel } from './fees';

/** Every capability an EVM network can have; a network removes what it lacks. */
export const EVM_CAPABILITIES: readonly Capability[] = [
  'tokens',
  'block-scan',
  'hd-public-derivation',
  'fee-market-1559',
  'finality-tag',
  'replace-fee',
  'cancel',
];

export type EvmFinality =
  | { readonly kind: 'tag' }
  | { readonly kind: 'confirmations'; readonly confirmations: number };

export interface EvmNetworkConfig {
  readonly chainId: bigint;
  readonly feeModel: EvmFeeModel;
  readonly finality: EvmFinality;
  /** The txpool's price bump; `undefined` when the network has no replace or cancel. */
  readonly minBumpPercent?: number;
  readonly minPriorityFeePerGas: bigint;
  /** OP Stack: transactions also pay an L1 data fee (`GasPriceOracle.getL1Fee`). */
  readonly l1DataFee: boolean;
  readonly capabilities: ReadonlySet<Capability>;
}

/** The OP Stack `GasPriceOracle` predeploy. */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

function finalityOf(
  policy: FinalityPolicy,
  fail: (reason: string) => never,
): EvmFinality {
  if (policy.kind === 'tag') return { kind: 'tag' };
  if (policy.kind === 'confirmations') {
    return { kind: 'confirmations', confirmations: policy.confirmations };
  }
  return fail(
    `finality '${policy.kind}' is not an EVM policy (use 'tag' or 'confirmations')`,
  );
}

export function evmNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
): EvmNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `EVM network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  if (network.identity === undefined || !/^[1-9][0-9]*$/.test(network.identity)) {
    fail('its identity must be the decimal chain id');
  }
  const feeModel = network.feeModel;
  if (feeModel !== 'evm-1559' && feeModel !== 'evm-legacy') {
    fail(`fee model '${feeModel}' is not 'evm-1559' or 'evm-legacy'`);
  }
  const finality = finalityOf(network.finality, fail);
  const capabilities = new Set<Capability>(EVM_CAPABILITIES);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  if (capabilities.has('fee-market-1559') !== (feeModel === 'evm-1559')) {
    fail(`'fee-market-1559' must be present exactly on 'evm-1559' networks`);
  }
  if (capabilities.has('finality-tag') !== (finality.kind === 'tag')) {
    fail(`'finality-tag' must be present exactly on 'tag' finality networks`);
  }
  // M3: the fee policy computes `BigInt(100 + percent)`, which throws on a fraction.
  const bump: unknown = network.replacement?.minBumpPercent;
  if (bump !== undefined && !(Number.isSafeInteger(bump) && (bump as number) >= 0)) {
    fail('replacement.minBumpPercent must be a non-negative integer');
  }
  const params = network.params ?? {};
  const minTip = params.minPriorityFeePerGas;
  if (minTip !== undefined && typeof minTip !== 'bigint') {
    fail('params.minPriorityFeePerGas must be a bigint');
  }
  if (params.l1DataFee !== undefined && params.l1DataFee !== 'op-stack') {
    fail(`params.l1DataFee must be 'op-stack'`);
  }
  const replaces = capabilities.has('replace-fee') || capabilities.has('cancel');
  return {
    chainId: BigInt(network.identity as string),
    feeModel: feeModel as EvmFeeModel,
    finality,
    ...(replaces ? { minBumpPercent: network.replacement?.minBumpPercent ?? 10 } : {}),
    minPriorityFeePerGas: (minTip as bigint | undefined) ?? 0n,
    l1DataFee: params.l1DataFee === 'op-stack',
    capabilities,
  };
}
