import type { ResolvedSelection } from '../config/types';
import type { ChainDriver } from '../driver/types';
import {
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
} from '../errors/error';
import {
  assetId,
  isAssetId,
  metadataProblem,
  parseAssetId,
  type AssetId,
  type AssetInfo,
  type AssetMetadata,
  type AssetRef,
} from '../model/asset';
import type { Catalogs } from '../registry/plugin';

/**
 * Resolves asset inputs strictly within one chain/network. Token metadata is cached per
 * container, and so is a token's own permanent failure (N6, R53: only a non-retryable
 * crypto-aio `ASSET_RESOLUTION` error, e.g. for a contract with no usable `decimals`), so a
 * junk token seen in every scanned block is queried once. Every other failure (a retryable
 * one of any code, any other provider error, or a foreign error) is dropped from the cache,
 * and the next resolution queries again: a provider fault must never pin a token.
 */
export class AssetService {
  readonly #metadata = new Map<AssetId, Promise<AssetMetadata>>();

  constructor(private readonly catalogs: () => Catalogs) {}

  async resolve(
    selection: ResolvedSelection,
    driver: ChainDriver,
    input: AssetRef | string | undefined,
  ): Promise<AssetInfo> {
    const chain = selection.chain.id;
    const network = selection.network.id;
    const catalogs = this.catalogs();
    if (input === undefined || input === 'native')
      return catalogs.assets.native(chain, network);
    if (typeof input === 'string') {
      if (!isAssetId(input)) return catalogs.assets.resolveAlias(chain, network, input);
      const parsed = parseAssetId(input);
      if (parsed.chain !== chain || parsed.network !== network) {
        throw new ValidationError(
          'ASSET_RESOLUTION',
          `asset '${input}' belongs to ${parsed.chain}:${parsed.network}, not ${chain}:${network}`,
        );
      }
      return this.resolve(selection, driver, parsed.ref);
    }
    const ref = driver.reader.normalizeTokenRef
      ? driver.reader.normalizeTokenRef(input)
      : input;
    const id = assetId(chain, network, ref);
    const known = catalogs.assets.get(id);
    if (known) return known;
    const lookup = driver.reader.getTokenMetadata;
    if (!selection.capabilities.has('tokens') || !lookup) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `chain '${chain}' does not support tokens`,
      );
    }
    let pending = this.#metadata.get(id);
    if (!pending) {
      pending = lookup.call(driver.reader, ref);
      this.#metadata.set(id, pending);
      pending.catch((error: unknown) => {
        if (!isCryptoAioError(error, 'ASSET_RESOLUTION') || error.retryable)
          this.#metadata.delete(id);
      });
    }
    const metadata = await pending;
    const problem = metadataProblem(metadata);
    if (problem)
      throw new ValidationError(
        'ASSET_RESOLUTION',
        `token '${id}' has unusable metadata: ${problem}`,
      );
    return Object.freeze({
      id,
      chain,
      network,
      ref,
      metadata: Object.freeze({ ...metadata }),
    });
  }
}
