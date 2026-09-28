/**
 * The Tron `ChainReader` and `ext.tron`. Tags follow the `ChainDriver` contract table:
 * reads `read`, heights and `observe` `monitor`. Addresses reach the node as `41…` hex.
 * A transaction the node holds but cannot serve whole yet (its receipt, its block) is a
 * retryable `PROVIDER_UNAVAILABLE`, never "not seen".
 */
import type {
  ChainReader,
  DriverBlock,
  DriverTransaction,
  DriverTxObservation,
} from '../../core/driver/types';
import {
  ProviderError,
  UnsupportedCapabilityError,
  ValidationError,
} from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { AssetMetadata, AssetRef, TokenRef } from '../../core/model/asset';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { Clock } from '../../core/util/clock';
import { SELECTORS, decodeString, decodeUint256, encodeBalanceOf } from './abi';
import { isTronAddress, toBase58Address, toHexAddress } from './address';
import { chainVerdict, decodeTransaction, verdictOf } from './decode';
import { MONITOR, READ, notServable, type TronApi, type TronTxJson } from './http';
import type { TronNetworkConfig } from './network';
import type { TronCallTags, TronCodec, TronExt, TronResources } from './types';

export interface TronContext {
  readonly api: TronApi;
  readonly codec: TronCodec;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: TronNetworkConfig;
  readonly clock: Clock;
  readonly log: Logger;
}

const TX_ID = /^[0-9a-f]{64}$/;
/** java-tron's block heights are `long`s. */
const INT64_MAX = 2n ** 63n - 1n;

/** A lower-case transaction or block id, or `null` (lesson 20: bounded before any work). */
function idOf(value: string): string | null {
  if (typeof value !== 'string' || value.length !== 64) return null;
  const id = value.toLowerCase();
  return TX_ID.test(id) ? id : null;
}

/**
 * Token metadata is read under the proof quorum (M4, the board's Plan 4 Task 4 note): the
 * core caches a token's decimals, symbol and "no such token" for the container's life, so one
 * lagging or buggy endpoint must not decide them. The constant call's quorum key compares the
 * verdict only (Task 4); endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`.
 */
const METADATA: TronCallTags = { ...READ, quorum: 'proof' };

function tokenProblem(reason: string): ValidationError {
  return new ValidationError('ASSET_RESOLUTION', `TRC-20 token unusable: ${reason}`);
}

/**
 * The `41…` hex contract of a TRC-20 ref. `UNSUPPORTED_CAPABILITY` for TRX or another token
 * standard; `ASSET_RESOLUTION` for a contract that is not a Tron address.
 */
export function trc20Contract(ref: AssetRef): string {
  if (ref === 'native' || ref.standard !== 'trc20') {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'Tron supports TRX and TRC-20 tokens only',
    );
  }
  if (!isTronAddress(ref.contract)) throw tokenProblem('not a Tron contract address');
  return toHexAddress(ref.contract);
}

/**
 * A constant call on a token (lesson 13, R66): a revert, a VM failure or no contract is the
 * token's own permanent problem (`ASSET_RESOLUTION`, cached by the core); node refusals stay
 * retryable and every other error propagates unchanged. "No contract" is a node's text, so
 * it counts only once `/wallet/getcontract` confirms it structurally with the same tags; a
 * node that shows a contract there decides nothing.
 */
export async function tokenCall(
  ctx: TronContext,
  owner: string,
  contract: string,
  data: string,
  tags: TronCallTags,
): Promise<string> {
  const answer = await ctx.api.constantCall(owner, contract, data, tags);
  if (answer.kind === 'no-contract') {
    if (await ctx.api.contractExists(contract, tags)) {
      throw new ProviderError(
        'PROVIDER_INCONSISTENT',
        'the node both holds and lacks this contract',
        { retryable: true },
      );
    }
    throw tokenProblem('no contract at this address');
  }
  if (answer.kind === 'failed') throw tokenProblem('the call failed');
  return answer.result;
}

/** A holder's TRC-20 balance. */
export async function trc20Balance(
  ctx: TronContext,
  contract: string,
  holder: string,
  tags: TronCallTags = READ,
): Promise<bigint> {
  const result = await tokenCall(
    ctx,
    toHexAddress(holder),
    contract,
    encodeBalanceOf(holder),
    tags,
  );
  try {
    return decodeUint256(result);
  } catch {
    throw tokenProblem('balanceOf returned no uint256');
  }
}

/**
 * An included transaction's observation. `guard` applies the verdict guard (lesson 7) to our
 * own Attempts; without it (a status lookup by id, `ordering === undefined`), the chain's own
 * view is reported (lesson 15).
 */
export async function observeIncluded(
  ctx: TronContext,
  id: string,
  tags: TronCallTags,
  guard: boolean,
): Promise<DriverTxObservation | null> {
  const info = await ctx.api.transactionInfo('full', id, tags);
  if (!info) return null;
  const [tx, header] = await Promise.all([
    ctx.api.transaction('full', id, tags),
    ctx.api.block('full', info.blockNumber, tags),
  ]);
  // The node indexed the info but cannot serve the transaction or its block yet: decide
  // nothing now (the core keeps its current observation on a retryable error).
  if (!tx || !header) throw notServable();
  const verdict = guard
    ? verdictOf(ctx.codec, tx, info)
    : chainVerdict(ctx.codec, tx, info);
  return {
    seen: 'block',
    txHash: id,
    blockHeight: info.blockNumber,
    blockHash: header.id,
    success: verdict.success,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

export function createTronReader(ctx: TronContext): ChainReader {
  const { api } = ctx;

  async function getTransaction(id: string): Promise<DriverTransaction | null> {
    const txId = idOf(id);
    if (txId === null) return null;
    const tx = await api.transaction('full', txId, READ);
    if (!tx) {
      const pending: TronTxJson | null = await api.pending(txId, READ);
      return pending
        ? decodeTransaction(ctx.codec, pending, null, undefined, true)
        : null;
    }
    // java-tron serves only included transactions here: without its receipt or its block
    // the answer is "not yet", never "not seen".
    const info = await api.transactionInfo('full', txId, READ);
    if (!info) throw notServable();
    const header = await api.block('full', info.blockNumber, READ);
    if (!header) throw notServable();
    return decodeTransaction(ctx.codec, tx, info, header.id);
  }

  return {
    async getBalance(address, asset) {
      if (asset === 'native')
        return (await api.account(toHexAddress(address), READ)).balance;
      return trc20Balance(ctx, trc20Contract(asset), address);
    },
    async getBlockHeight() {
      return ((await api.block('full', undefined, MONITOR)) as { number: bigint }).number;
    },
    async getFinalizedHeight() {
      return ((await api.block('solid', undefined, MONITOR)) as { number: bigint })
        .number;
    },
    async getBlock(ref): Promise<DriverBlock | null> {
      const key = typeof ref === 'string' ? idOf(ref) : ref;
      if (key === null || (typeof key === 'bigint' && (key < 0n || key > INT64_MAX))) {
        return null;
      }
      const header = await api.block('full', key, READ);
      return header
        ? {
            height: header.number,
            hash: header.id,
            parentHash: header.parentId,
            timestamp: header.timestamp,
          }
        : null;
    },
    getTransaction,
    async observe(ref, ordering) {
      const id = idOf(ref.id);
      if (id === null) return { seen: 'none' };
      const included = await observeIncluded(ctx, id, MONITOR, ordering !== undefined);
      if (included) return included;
      return (await api.pending(id, MONITOR)) ? { seen: 'mempool' } : { seen: 'none' };
    },
    async getTokenMetadata(ref: TokenRef): Promise<AssetMetadata> {
      const contract = trc20Contract(ref);
      // The contract's own account is the caller: it always exists.
      const decimalsWord = await tokenCall(
        ctx,
        contract,
        contract,
        SELECTORS.decimals,
        METADATA,
      );
      const symbolWord = await tokenCall(
        ctx,
        contract,
        contract,
        SELECTORS.symbol,
        METADATA,
      );
      let decimals: bigint;
      let symbol: string;
      try {
        decimals = decodeUint256(decimalsWord);
        symbol = decodeString(symbolWord);
      } catch {
        throw tokenProblem('unreadable decimals or symbol');
      }
      if (decimals > 255n || symbol.length === 0) {
        throw tokenProblem('decimals or symbol out of range');
      }
      return { symbol, decimals: Number(decimals) };
    },
    normalizeTokenRef(ref: TokenRef): TokenRef {
      if (ref.standard !== 'trc20') {
        throw new ValidationError(
          'ASSET_RESOLUTION',
          'Tron tokens use the trc20 standard',
        );
      }
      if (!isTronAddress(ref.contract)) throw tokenProblem('not a Tron contract address');
      return { standard: 'trc20', contract: toBase58Address(ref.contract) };
    },
  };
}

/** `ext.tron` (spec §5.5). */
export function createTronExt(ctx: TronContext): TronExt {
  return {
    tron: {
      getResources: (address: string): Promise<TronResources> =>
        ctx.api.resources(toHexAddress(address), READ),
    },
  };
}
