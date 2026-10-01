/**
 * What every Avalanche port is built from, the transport tags of the `ChainDriver` contract
 * table, and the locator: which accepted block holds a transaction.
 *
 * AvalancheGo can say a transaction is accepted, never in which block. The locator asks the
 * Data API, then checks the answer against the node's block; a transaction the indexer does
 * not know yet (it trails the chain by seconds) is looked for in the newest `SCAN_DEPTH`
 * blocks. Accepted blocks never change (Snowman finality), so a location is kept once found.
 * A location found on one endpoint is only a candidate for proofs: every proof re-reads its
 * block under the proof quorum, and a candidate the quorum contradicts is forgotten.
 */
import { ProviderError, isCryptoAioError } from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { Clock } from '../../core/util/clock';
import type { AvalancheNode, DataApi, Location } from './api';
import type { AvalancheNetworkConfig } from './network';
import type { AvalancheCallTags } from './types';

export const READ: AvalancheCallTags = { purpose: 'read', retry: 'safe' };
export const MONITOR: AvalancheCallTags = { purpose: 'monitor', retry: 'safe' };
export const PROOF: AvalancheCallTags = {
  purpose: 'proof',
  retry: 'safe',
  quorum: 'proof',
};

export const withSignal = (
  tags: AvalancheCallTags,
  signal?: AbortSignal,
): AvalancheCallTags => (signal ? { ...tags, signal } : tags);

/** How many blocks below the head the locator reads when the indexer does not know a tx. */
export const SCAN_DEPTH = 16;
/** Locations kept per driver (oldest dropped first). */
const LOCATIONS = 10_000;

export class LocationCache {
  readonly #entries = new Map<string, Location>();

  get(txId: string): Location | undefined {
    return this.#entries.get(txId);
  }

  set(txId: string, location: Location): void {
    this.#entries.set(txId, location);
    if (this.#entries.size > LOCATIONS) {
      this.#entries.delete(this.#entries.keys().next().value as string);
    }
  }

  forget(txId: string): void {
    this.#entries.delete(txId);
  }
}

export interface AvalancheContext {
  readonly node: AvalancheNode;
  readonly dataApi: DataApi;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: AvalancheNetworkConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly located: LocationCache;
}

export const undecided = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason);

/** Two reads that cannot both hold decide nothing (retryable). */
export const contradiction = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

/**
 * On a proof path only a definitive negative proof may answer "no".
 * Every other non-retryable provider error (a JSON-RPC error that is not a "not found" the
 * caller already mapped, a proxy's 4xx, a 401/403) becomes a retryable
 * `PROVIDER_UNAVAILABLE` here, so it never decides anything. Retryable errors pass as they
 * are. The cost is liveness only.
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

/** A location is a candidate, read on one endpoint: never a quorum read. */
const singleRead = (tags: AvalancheCallTags): AvalancheCallTags => ({
  purpose: tags.purpose === 'proof' ? 'monitor' : (tags.purpose ?? 'read'),
  retry: 'safe',
  ...(tags.signal ? { signal: tags.signal } : {}),
});

/**
 * The accepted block holding `txId`, a transaction the node has accepted: from the cache,
 * else the indexer (checked against the node's block at its height), else the newest
 * `SCAN_DEPTH` blocks. `undefined` when none of them names it yet, `'no-block'` for an
 * X-Chain transaction from before the chain had blocks. Reads are single
 * (`monitor` or `read`) reads: a location is a candidate; proofs re-read it under quorum.
 */
export async function locate(
  ctx: AvalancheContext,
  txId: string,
  tags: AvalancheCallTags,
): Promise<Location | 'no-block' | undefined> {
  const cached = ctx.located.get(txId);
  if (cached) return cached;
  const read = singleRead(tags);
  const indexed = await ctx.dataApi.locate(txId, read);
  // An X-Chain transaction accepted before the linearization (April 2023) has no block.
  if (indexed === 'no-block') return 'no-block';
  if (indexed !== null) {
    const block = await ctx.node.blockAt(indexed.height, read);
    if (block === null) return undefined; // the node has not reached it yet
    if (block.id !== indexed.hash || !block.txIds.includes(txId)) {
      throw contradiction("the indexer's block for the transaction is not the node's");
    }
    ctx.located.set(txId, indexed);
    return indexed;
  }
  const head = await ctx.node.height(read);
  const lowest = head - BigInt(SCAN_DEPTH) + 1n;
  for (let height = head; height >= 0n && height >= lowest; height--) {
    const block = await ctx.node.blockAt(height, read);
    if (block?.txIds.includes(txId)) {
      const found = { height: block.height, hash: block.id };
      ctx.located.set(txId, found);
      return found;
    }
  }
  return undefined;
}
