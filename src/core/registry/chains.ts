import { ConfigError } from '../errors/error';
import type { ChainInfo, NetworkInfo } from '../model/chain';
import { unknownName } from '../util/names';

export class ChainCatalog {
  readonly #chains = new Map<string, ChainInfo>();

  register(chain: ChainInfo): void {
    validateChain(chain);
    if (this.#chains.has(chain.id)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `chain '${chain.id}' is already registered`,
      );
    }
    this.#chains.set(chain.id, Object.freeze({ ...chain }));
  }

  has(id: string): boolean {
    return this.#chains.has(id);
  }

  get(id: string): ChainInfo {
    const chain = this.#chains.get(id);
    if (!chain) {
      // The caller's text (perhaps a pasted secret) is never repeated; the registered
      // chains are listed.
      throw new ConfigError('CONFIG_INVALID', unknownName('chain', this.#chains.keys()));
    }
    return chain;
  }

  list(): ChainInfo[] {
    return [...this.#chains.values()];
  }

  network(chainId: string, networkId: string): NetworkInfo {
    const chain = this.get(chainId);
    // Own keys only: `toString` or `constructor` is not a network.
    const network = Object.hasOwn(chain.networks, networkId)
      ? chain.networks[networkId]
      : undefined;
    if (!network) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName(`network for chain '${chain.id}'`, Object.keys(chain.networks)),
      );
    }
    return network;
  }

  clone(): ChainCatalog {
    const copy = new ChainCatalog();
    for (const chain of this.#chains.values()) copy.#chains.set(chain.id, chain);
    return copy;
  }
}

function validateChain(chain: ChainInfo): void {
  const fail = (reason: string): never => {
    throw new ConfigError('CONFIG_INVALID', `invalid chain '${chain.id}': ${reason}`);
  };
  if (!/^[a-z][a-z0-9-]*$/.test(chain.id)) fail('id must be lowercase kebab-case');
  if (!chain.networks[chain.defaultNetwork]) {
    fail(`default network '${chain.defaultNetwork}' is not defined`);
  }
  const { decimals } = chain.nativeAsset;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    fail('native asset decimals must be an integer in [0, 255]');
  }
  if (chain.schemes.length === 0) fail('at least one signature scheme is required');
  if (
    chain.xpubNetworkClass !== undefined &&
    typeof chain.xpubNetworkClass !== 'boolean'
  ) {
    fail('xpubNetworkClass must be a boolean');
  }
  for (const [key, network] of Object.entries(chain.networks)) {
    if (network.id !== key)
      fail(`network key '${key}' does not match its id '${network.id}'`);
    if (!Number.isInteger(network.reorgWindow) || network.reorgWindow < 1) {
      fail(`network '${key}': reorgWindow must be a positive integer`);
    }
    if (
      !Number.isInteger(network.defaultConfirmations) ||
      network.defaultConfirmations < 1
    ) {
      fail(`network '${key}': defaultConfirmations must be a positive integer`);
    }
  }
}
