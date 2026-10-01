/**
 * What the Avalanche driver needs from a network's registry entry and from the handle's
 * `options`, validated once when a driver is created, so bad data fails with
 * `CONFIG_INVALID` instead of misbehaving (lessons 10 and 14: every number is checked).
 * SDK-free.
 */
import { ConfigError } from '../../core/errors/error';
import { KNOWN_CAPABILITIES, type Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { unknownName } from '../../core/util/names';
import { isId } from './cb58';
import type { AvalancheVm } from './types';

/**
 * Every capability of an Avalanche network. The Data API indexer is required (spec §15's
 * shape for UTXO chains): it locates a transaction's block and serves address history.
 */
export const AVALANCHE_CAPABILITIES: readonly Capability[] = Object.freeze([
  'batch-transfer',
  'memo',
  'block-scan',
  'address-history',
  'hd-public-derivation',
]);

export interface AvalancheNetworkConfig {
  readonly vm: AvalancheVm;
  /** The chain alias addresses carry: `X` or `P`. */
  readonly alias: 'X' | 'P';
  readonly networkId: number;
  /** The bech32 human-readable part of addresses: `avax`, `fuji`. */
  readonly hrp: string;
  /** The chain's own id (CB58), written into every transaction. */
  readonly blockchainId: string;
  readonly avaxAssetId: string;
  /** The id of the block at height 0: the endpoint identity (spec §11). */
  readonly genesisBlockId: string;
  /** Finality depth N: a block with N confirmations is final. */
  readonly confirmations: number;
  /** Absurd-fee guard: the highest fee (nAVAX) a transfer ever pays. */
  readonly maxFee: bigint;
  /** P-Chain: above this gas price (nAVAX per gas) an endpoint's fee state decides nothing. */
  readonly maxGasPrice: bigint;
  readonly capabilities: ReadonlySet<Capability>;
}

/** Library defaults for the handle `options`. */
export const OPTION_DEFAULTS = Object.freeze({
  maxFee: 100_000_000n, // 0.1 AVAX
  maxGasPrice: 10_000n, // 10,000 × the P-Chain's minimum price
});

const OPTION_KEYS = new Set(Object.keys(OPTION_DEFAULTS));

/**
 * F3-R15: a network's capability overrides, checked against what the driver serves. The
 * handle advertises the manifest's capabilities plus `add`, minus `remove`, and the core
 * accepts what it advertises, so each name must be one the driver serves; the error names a
 * library capability, never a caller's unknown text.
 */
function checkCapabilities(network: NetworkInfo, fail: (reason: string) => never): void {
  const add: unknown = network.capabilities?.add ?? [];
  const remove: unknown = network.capabilities?.remove ?? [];
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    fail('capabilities.add and capabilities.remove must be lists');
  }
  const serves = `the Avalanche driver serves ${AVALANCHE_CAPABILITIES.join(', ')}`;
  for (const [side, names] of [
    ['add', add],
    ['remove', remove],
  ] as const) {
    for (const name of names as readonly unknown[]) {
      if (AVALANCHE_CAPABILITIES.includes(name as Capability)) continue;
      const known = (KNOWN_CAPABILITIES as readonly unknown[]).includes(name);
      fail(
        `capabilities.${side}: ${known ? `'${String(name)}' is not one` : 'an unknown name'}; ${serves}`,
      );
    }
  }
}

export function avalancheNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
  options: Readonly<Record<string, unknown>> = {},
): AvalancheNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Avalanche network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  const params = network.params ?? {};
  const vm = params.vm;
  if (vm !== 'avm' && vm !== 'pvm') fail(`params.vm must be 'avm' or 'pvm'`);
  const alias = params.alias;
  if (alias !== (vm === 'avm' ? 'X' : 'P')) {
    fail(`params.alias must be '${vm === 'avm' ? 'X' : 'P'}' for the ${vm} chain`);
  }
  const expectedFee = vm === 'avm' ? 'avalanche-static' : 'avalanche-dynamic';
  if (network.feeModel !== expectedFee) {
    fail(`fee model '${network.feeModel}' is not '${expectedFee}'`);
  }
  const networkId = params.networkId;
  if (
    !Number.isSafeInteger(networkId) ||
    (networkId as number) < 1 ||
    (networkId as number) > 0xffffffff
  ) {
    fail('params.networkId must be an integer from 1 to 2^32 - 1');
  }
  const hrp = params.hrp;
  // 83 is bech32's limit; an address of 20 bytes then still fits in 90 characters.
  if (typeof hrp !== 'string' || !/^[a-z]{1,40}$/.test(hrp)) {
    fail('params.hrp must be a lowercase human-readable part of 1 to 40 letters');
  }
  for (const key of ['blockchainId', 'avaxAssetId'] as const) {
    if (!isId(params[key])) fail(`params.${key} must be a CB58 id of 32 bytes`);
  }
  if (!isId(network.identity)) {
    fail('its identity must be the CB58 id of the block at height 0');
  }
  const finality = network.finality;
  if (finality.kind !== 'confirmations') {
    fail(`finality '${finality.kind}' is not an Avalanche policy (use 'confirmations')`);
  }
  const confirmations = (finality as { confirmations: unknown }).confirmations;
  if (!Number.isSafeInteger(confirmations) || (confirmations as number) < 1) {
    fail('finality.confirmations must be a safe integer >= 1');
  }

  for (const key of Object.keys(options)) {
    // F3-R16: the accepted names, never the caller's key (it may be a pasted secret).
    if (!OPTION_KEYS.has(key)) fail(unknownName('option', OPTION_KEYS));
  }
  const merged: Readonly<Record<string, unknown>> = { ...OPTION_DEFAULTS, ...options };
  const positive = (key: string): bigint => {
    const value = merged[key];
    if (typeof value !== 'bigint' || value < 1n)
      fail(`options.${key} must be a bigint >= 1`);
    return value as bigint;
  };
  const maxFee = positive('maxFee');
  const maxGasPrice = positive('maxGasPrice');

  checkCapabilities(network, fail);
  const capabilities = new Set<Capability>(AVALANCHE_CAPABILITIES);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  return {
    vm: vm as AvalancheVm,
    alias: alias as 'X' | 'P',
    networkId: networkId as number,
    hrp: hrp as string,
    blockchainId: params.blockchainId as string,
    avaxAssetId: params.avaxAssetId as string,
    genesisBlockId: network.identity as string,
    confirmations: confirmations as number,
    maxFee,
    maxGasPrice,
    capabilities,
  };
}
