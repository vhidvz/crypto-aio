import { ValidationError } from '../errors/error';

export type AssetRef =
  'native' | { readonly standard: string; readonly contract: string };
export type TokenRef = Exclude<AssetRef, 'native'>;
export type AssetId = string;

export interface AssetMetadata {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
}

export interface AssetInfo {
  readonly id: AssetId;
  readonly chain: string;
  readonly network: string;
  readonly ref: AssetRef;
  readonly metadata: AssetMetadata;
}

const ASSET_ID = /^([a-z][a-z0-9-]*):([a-z0-9-]+)\/(?:(native)|([a-z0-9-]+):(.+))$/;

export function assetId(chain: string, network: string, ref: AssetRef): AssetId {
  return ref === 'native'
    ? `${chain}:${network}/native`
    : `${chain}:${network}/${ref.standard}:${ref.contract}`;
}

export function isAssetId(value: string): boolean {
  return ASSET_ID.test(value);
}

export function parseAssetId(id: string): {
  chain: string;
  network: string;
  ref: AssetRef;
} {
  const match = ASSET_ID.exec(id);
  if (!match) throw new ValidationError('ASSET_RESOLUTION', `malformed asset id '${id}'`);
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
