import { ValidationError } from '../errors/error';

/** An asset of one network: its native coin, or a token by standard and contract. */
export type AssetRef =
  'native' | { readonly standard: string; readonly contract: string };
/** A token: an `AssetRef` that is not `native`. */
export type TokenRef = Exclude<AssetRef, 'native'>;
/**
 * An asset's id: `<chain>:<network>/native`, or `<chain>:<network>/<standard>:<contract>`
 * with the contract in the driver's canonical form.
 */
export type AssetId = string;

/** What an amount of the asset is shown and scaled with. */
export interface AssetMetadata {
  readonly symbol: string;
  /** An integer from 0 to 255: base units per whole unit is 10^decimals. */
  readonly decimals: number;
  readonly name?: string;
}

/** A resolved asset: its id, where it lives, and its metadata. */
export interface AssetInfo {
  readonly id: AssetId;
  readonly chain: string;
  readonly network: string;
  readonly ref: AssetRef;
  readonly metadata: AssetMetadata;
}

const ASSET_ID = /^([a-z][a-z0-9-]*):([a-z0-9-]+)\/(?:(native)|([a-z0-9-]+):(.+))$/;

/** The id of `ref` on `chain`'s `network`; `ref`'s contract is used as given. */
export function assetId(chain: string, network: string, ref: AssetRef): AssetId {
  return ref === 'native'
    ? `${chain}:${network}/native`
    : `${chain}:${network}/${ref.standard}:${ref.contract}`;
}

export function isAssetId(value: string): boolean {
  return ASSET_ID.test(value);
}

/** The chain, network and ref of an asset id; `ASSET_RESOLUTION` for a malformed one. */
export function parseAssetId(id: string): {
  chain: string;
  network: string;
  ref: AssetRef;
} {
  const match = ASSET_ID.exec(id);
  // A malformed id is the caller's text, which may be a pasted secret: never repeated.
  if (!match) throw new ValidationError('ASSET_RESOLUTION', 'malformed asset id');
  const [, chain, network, native, standard, contract] = match;
  return {
    chain: chain as string,
    network: network as string,
    ref: native
      ? 'native'
      : { standard: standard as string, contract: contract as string },
  };
}

export function sameAssetRef(a: AssetRef, b: AssetRef): boolean {
  if (a === 'native' || b === 'native') return a === b;
  return a.standard === b.standard && a.contract === b.contract;
}

/** Returns a reason when metadata is unusable, otherwise `undefined`. */
export function metadataProblem(metadata: AssetMetadata): string | undefined {
  if (!metadata.symbol) return 'symbol must not be empty';
  const { decimals } = metadata;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return 'decimals must be an integer in [0, 255]';
  }
  return undefined;
}
