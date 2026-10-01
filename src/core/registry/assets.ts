import { ConfigError, ValidationError } from '../errors/error';
import {
  assetId,
  metadataProblem,
  type AssetId,
  type AssetInfo,
  type AssetMetadata,
  type AssetRef,
} from '../model/asset';
import type { ChainInfo } from '../model/chain';
import { unknownName } from '../util/names';

export interface AssetRegistration {
  readonly chain: string;
  readonly network: string;
  readonly ref: AssetRef;
  readonly metadata: AssetMetadata;
  readonly aliases?: readonly string[];
}

const ALIAS = /^[A-Z0-9._-]{1,32}$/;

export class AssetCatalog {
  readonly #byId = new Map<AssetId, AssetInfo>();
  readonly #aliases = new Map<string, Map<string, AssetId>>();

  register(registration: AssetRegistration): AssetInfo {
    const id = assetId(registration.chain, registration.network, registration.ref);
    const problem = metadataProblem(registration.metadata);
    if (problem) throw new ConfigError('CONFIG_INVALID', `asset '${id}': ${problem}`);
    const existing = this.#byId.get(id);
    if (
      existing &&
      (existing.metadata.symbol !== registration.metadata.symbol ||
        existing.metadata.decimals !== registration.metadata.decimals)
    ) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `asset '${id}' is already registered with different metadata`,
      );
    }
    const scopeKey = `${registration.chain}:${registration.network}`;
    const scope = this.#aliases.get(scopeKey) ?? new Map<string, AssetId>();
    const aliases = (registration.aliases ?? []).map((alias) => {
      const normalized = alias.trim().toUpperCase();
      if (!ALIAS.test(normalized)) {
        throw new ConfigError('CONFIG_INVALID', `invalid asset alias '${alias}'`);
      }
      const owner = scope.get(normalized);
      if (owner && owner !== id) {
        throw new ConfigError(
          'CONFIG_INVALID',
          `alias '${normalized}' on ${scopeKey} already refers to '${owner}'`,
        );
      }
      return normalized;
    });
    const info: AssetInfo =
      existing ??
      Object.freeze({
        id,
        chain: registration.chain,
        network: registration.network,
        ref: registration.ref,
        metadata: Object.freeze({ ...registration.metadata }),
      });
    this.#byId.set(id, info);
    for (const alias of aliases) scope.set(alias, id);
    this.#aliases.set(scopeKey, scope);
    return info;
  }

  registerNative(chain: ChainInfo): void {
    for (const network of Object.keys(chain.networks)) {
      this.register({
        chain: chain.id,
        network,
        ref: 'native',
        metadata: chain.nativeAsset,
        aliases: [chain.nativeAsset.symbol],
      });
    }
  }

  get(id: AssetId): AssetInfo | undefined {
    return this.#byId.get(id);
  }

  native(chain: string, network: string): AssetInfo {
    const info = this.#byId.get(assetId(chain, network, 'native'));
    if (!info) {
      throw new ValidationError(
        'ASSET_RESOLUTION',
        `no native asset registered for ${chain}:${network}`,
      );
    }
    return info;
  }

  resolveAlias(chain: string, network: string, alias: string): AssetInfo {
    const scopeKey = `${chain}:${network}`;
    const scope = this.#aliases.get(scopeKey);
    const id = scope?.get(alias.trim().toUpperCase());
    const info = id ? this.#byId.get(id) : undefined;
    if (!info) {
      throw new ValidationError(
        'ASSET_RESOLUTION',
        unknownName(`asset alias on ${scopeKey}`, scope?.keys() ?? []),
      );
    }
    return info;
  }

  clone(): AssetCatalog {
    const copy = new AssetCatalog();
    for (const [id, info] of this.#byId) copy.#byId.set(id, info);
    for (const [key, scope] of this.#aliases) copy.#aliases.set(key, new Map(scope));
    return copy;
  }
}
