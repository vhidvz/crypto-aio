/**
 * What every UTXO port is built from, the transport tags of the `ChainDriver` contract
 * table, and the wallet options every builder call parses.
 */
import type { WalletOptions } from '../../core/driver/types';
import {
  ConfigError,
  ProviderError,
  UnsupportedCapabilityError,
  isCryptoAioError,
} from '../../core/errors/error';
import type { AssetRef } from '../../core/model/asset';
import { unknownName } from '../../core/util/names';
import type { Logger } from '../../core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { decodeAddress, type DecodedAddress } from './address';
import type { EsploraClient } from './esplora';
import type { UtxoNetworkConfig } from './network';
import type { UtxoAddressType, UtxoCallTags } from './types';

export interface UtxoContext {
  readonly esplora: EsploraClient;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: UtxoNetworkConfig;
  readonly log: Logger;
}

export const READ: UtxoCallTags = { purpose: 'read', retry: 'safe' };
export const MONITOR: UtxoCallTags = { purpose: 'monitor', retry: 'safe' };
export const PROOF: UtxoCallTags = { purpose: 'proof', retry: 'safe', quorum: 'proof' };

export const withSignal = (tags: UtxoCallTags, signal?: AbortSignal): UtxoCallTags =>
  signal ? { ...tags, signal } : tags;

/**
 * Runs `work` on each item, at most `limit` at a time. After a failure the
 * other runners stop at their next step, and the first failure is thrown.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const runner = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

/**
 * On a proof path only a definitive negative proof may answer "no"
 * (for Bitcoin: a quorum-attested final spend by another transaction). Every other RPC or
 * HTTP error decides nothing: a non-retryable provider error, such as a CDN or proxy 400,
 * 410 or 422 (the transport's `RPC_ERROR`, ambiguous or not) or a 401/403
 * (`PROVIDER_MISCONFIGURED`), becomes a retryable `PROVIDER_UNAVAILABLE` here, so the monitor
 * never rethrows it. Retryable provider errors already decide nothing and pass unchanged, as
 * do Esplora's own 404s, which the client maps to `null` first. The cost is liveness only.
 */
export async function proofRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isCryptoAioError(error) && error.category === 'provider' && !error.retryable) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'the proof read failed on this endpoint; nothing is decided',
        { cause: error },
      );
    }
    throw error;
  }
}

export const ADDRESS_TYPES: readonly UtxoAddressType[] = [
  'p2wpkh',
  'p2sh-p2wpkh',
  'p2pkh',
  'p2tr',
];

export interface ParsedWalletOptions {
  readonly addressType: UtxoAddressType;
  readonly changeAddress?: DecodedAddress;
  /** The explicit opt-out for a change address the wallet's key does not derive. */
  readonly allowExternalChangeAddress: boolean;
}

const WALLET_OPTION_KEYS = ['addressType', 'changeAddress', 'allowExternalChangeAddress'];

/**
 * `WalletConfig.utxo`, validated (`CONFIG_INVALID`): the address type, the change address
 * and its opt-out. Whether the wallet derives the change address is checked where the
 * wallet's keys are known (`changeAddressOf`, `spend.ts`).
 */
export function parseWalletOptions(
  wallet: WalletOptions | undefined,
  config: UtxoNetworkConfig,
): ParsedWalletOptions {
  const raw = wallet?.utxo;
  if (raw === undefined)
    return { addressType: 'p2wpkh', allowExternalChangeAddress: false };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('CONFIG_INVALID', 'wallet.utxo must be an object');
  }
  const options = raw as Readonly<Record<string, unknown>>;
  // The accepted names, never the caller's key (it may be a pasted secret).
  if (Object.keys(options).some((key) => !WALLET_OPTION_KEYS.includes(key))) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `wallet.utxo has an ${unknownName('option', WALLET_OPTION_KEYS)}`,
    );
  }
  const type = options.addressType ?? 'p2wpkh';
  if (!ADDRESS_TYPES.includes(type as UtxoAddressType)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `wallet.utxo.addressType must be one of ${ADDRESS_TYPES.join(', ')}`,
    );
  }
  let changeAddress: DecodedAddress | undefined;
  if (options.changeAddress !== undefined) {
    try {
      changeAddress = decodeAddress(options.changeAddress as string, config.address);
    } catch {
      throw new ConfigError(
        'CONFIG_INVALID',
        'wallet.utxo.changeAddress is not a valid address on this network',
      );
    }
  }
  const external = options.allowExternalChangeAddress ?? false;
  if (typeof external !== 'boolean') {
    throw new ConfigError(
      'CONFIG_INVALID',
      'wallet.utxo.allowExternalChangeAddress must be a boolean',
    );
  }
  return {
    addressType: type as UtxoAddressType,
    ...(changeAddress ? { changeAddress } : {}),
    allowExternalChangeAddress: external,
  };
}

export function assertNative(asset: AssetRef): void {
  if (asset !== 'native') {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'Bitcoin has no tokens; only the native asset can be sent',
    );
  }
}

/** Splits an `inputs` ordering entry (`txid:vout`); malformed data decides nothing. */
export function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(outpoint);
  if (!match || Number(match[2]) > 0xffffffff) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'malformed outpoint in the ordering');
  }
  return { txid: match[1] as string, vout: Number(match[2]) };
}
