/**
 * The EVM family plugin: chains, tokens and provider presets as data, plus one
 * adapter manifest per library. SDK-free: only a manifest's `load()` requires a client
 * module, and with it the SDK. `ethers` is registered first, so it is the family default.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import { ConfigError } from '../../core/errors/error';
import type { ChainInfo } from '../../core/model/chain';
import type { AssetRegistration } from '../../core/registry/assets';
import type { Plugin } from '../../core/registry/plugin';
import type { ProviderPreset } from '../../core/registry/providers';
import { toHex, utf8ToBytes } from '../../core/util/bytes';
import { EVM_CHAINS } from './chains';
import { EVM_CAPABILITIES, evmNetworkConfig } from './network';
import { EVM_PRESETS } from './presets';
import { EVM_TOKENS } from './tokens';

/** The SDK versions this adapter is validated against. */
export const EVM_PEER_DEPENDENCIES: Readonly<Record<'ethers' | 'web3', PeerDependency>> =
  {
    ethers: { name: 'ethers', range: '^6.17.0' },
    web3: { name: 'web3', range: '^4.16.0' },
  };

/**
 * The manifests' `load` functions, shared by every `evmManifests(...)` call, so that
 * registering `evmPlugin()` or the same `evmChainPlugin(...)` again is the same plugin:
 * the registry compares a plugin's functions by identity, and refuses a different plugin
 * under a registered name. Each `require`s its client module, and with it the SDK, only
 * when called.
 */
const loadEthers = async (): Promise<DriverFactory> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./ethers-client') as typeof import('./ethers-client');
  return mod.ethersDriverFactory;
};

const loadWeb3 = async (): Promise<DriverFactory> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./web3-client') as typeof import('./web3-client');
  return mod.web3DriverFactory;
};

/** The `ethers` and `web3` manifests for `chains`, keyed `<family>/<library>`. */
export function evmManifests(
  family: string,
  chains: readonly string[],
): AdapterManifest[] {
  return [
    {
      family,
      library: 'ethers',
      chains,
      capabilities: EVM_CAPABILITIES,
      peerDependencies: [EVM_PEER_DEPENDENCIES.ethers],
      load: loadEthers,
    },
    {
      family,
      library: 'web3',
      chains,
      capabilities: EVM_CAPABILITIES,
      peerDependencies: [EVM_PEER_DEPENDENCIES.web3],
      load: loadWeb3,
    },
  ];
}

/**
 * The built-in EVM family: Ethereum, BNB Smart Chain, Polygon PoS, Avalanche C-Chain,
 * Arbitrum One, OP Mainnet and Base, with their testnets.
 */
export function evmPlugin(): Plugin {
  return {
    name: 'evm',
    chains: EVM_CHAINS,
    adapters: evmManifests(
      'evm',
      EVM_CHAINS.map((chain) => chain.id),
    ),
    presets: EVM_PRESETS,
    assets: EVM_TOKENS,
  };
}

/** A plugin name: lower-case letters, digits and hyphens, starting with a letter. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** `0x` and 40 hex digits, in any case. */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55: each letter upper-cased where the keccak-256 of the lower-case hex has 8 or more. */
function eip55(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(utf8ToBytes(hex)));
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * An ERC-20 registration under the contract the driver names it by. The driver normalizes
 * every token ref it is given, reads or decodes to the EIP-55 form, and an asset id carries
 * the contract as registered, so a lower-case registration would be a second asset of the
 * same token: its alias would resolve to one id, and the token's own transfers, deposits
 * and balances by ref to another. A mixed-case contract with a wrong checksum is a typo,
 * refused as the driver refuses it in a transfer. The refusal never repeats the value.
 */
function erc20Registration(asset: AssetRegistration, name: string): AssetRegistration {
  const { ref } = asset;
  if (ref === 'native') return asset;
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `EVM chain plugin '${name}': the asset ${JSON.stringify(asset.metadata.symbol)} on ${asset.chain}:${asset.network} ${reason}`,
    );
  };
  if (ref.standard !== 'erc20') fail(`must use the 'erc20' standard`);
  if (!HEX_ADDRESS.test(ref.contract)) fail('needs a 0x-prefixed 20-byte hex contract');
  const contract = eip55(ref.contract);
  const digits = ref.contract.slice(2);
  const mixedCase = /[a-f]/.test(digits) && /[A-F]/.test(digits);
  if (mixedCase && contract !== ref.contract)
    fail('has a contract with a wrong checksum');
  return contract === ref.contract ? asset : { ...asset, ref: { ...ref, contract } };
}

export interface EvmChainPluginOptions {
  /**
   * A unique name matching `/^[a-z][a-z0-9-]*$/`. The plugin registers as `evm:<name>`, so
   * it never collides with a family plugin, and its manifests as `evm:<name>/ethers` and
   * `evm:<name>/web3`.
   */
  readonly name: string;
  /** Chains with `family: 'evm'`, nonce ordering and the `secp256k1-ecdsa` scheme. */
  readonly chains: readonly ChainInfo[];
  readonly presets?: readonly ProviderPreset[];
  /**
   * Tokens: `erc20` refs, each registered under its EIP-55 checksummed contract, whatever
   * case it is given in, so its alias and its transfers name one asset id.
   */
  readonly assets?: readonly AssetRegistration[];
}

/**
 * A plugin for EVM chains of your own, served by the built-in EVM driver with either
 * library. Every network and token is validated here, so bad data fails at registration.
 */
export function evmChainPlugin(options: EvmChainPluginOptions): Plugin {
  if (!PLUGIN_NAME.test(options.name)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `EVM chain plugin name ${JSON.stringify(options.name)} must match ${String(PLUGIN_NAME)}`,
    );
  }
  const name = `evm:${options.name}`;
  for (const chain of options.chains) {
    const fail = (reason: string): never => {
      throw new ConfigError('CONFIG_INVALID', `EVM chain '${chain.id}': ${reason}`);
    };
    if (chain.family !== 'evm') fail(`its family must be 'evm'`);
    if (chain.model !== 'account' || chain.ordering !== 'nonce') {
      fail(`it must use the account model and nonce ordering`);
    }
    if (chain.schemes.length !== 1 || chain.schemes[0] !== 'secp256k1-ecdsa') {
      fail(`its only scheme must be 'secp256k1-ecdsa'`);
    }
    for (const network of Object.values(chain.networks)) evmNetworkConfig(chain, network);
  }
  return {
    name,
    chains: options.chains,
    adapters: evmManifests(
      name,
      options.chains.map((chain) => chain.id),
    ),
    ...(options.presets ? { presets: options.presets } : {}),
    ...(options.assets
      ? { assets: options.assets.map((asset) => erc20Registration(asset, name)) }
      : {}),
  };
}
