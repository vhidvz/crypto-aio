import { toBlock, toTransaction, type MappingContext } from '../blockchain/mapping';
import type { BlockSource, ScanFilter } from '../driver/types';
import { ConfigError, StateError, isCryptoAioError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { AssetRef } from '../model/asset';
import type { Block, Transaction } from '../model/transaction';
import type { CursorStore, ScanCursor } from '../store/types';
import { isStaleView, type StaleViewSource } from '../transport/stale-view';
import type { Clock } from '../util/clock';

export interface ScannerOptions {
  /** Durable name of this consumer's position (namespaced per container, chain and network). */
  readonly cursorKey: string;
  /**
   * Where a NEW cursor starts; ignored when a stored cursor exists. Default `'latest'`. The
   * new cursor also retains the `reorgWindow` blocks below the start, so a rollback within
   * the first window can name blocks that were never delivered, and the replay that follows
   * can start below `from`.
   */
  readonly from?: 'latest' | bigint;
  /**
   * `'final'` emits finalized blocks only; a rollback can then still come from a provider
   * inconsistency (spec §10). `'head'` follows the tip and may roll back within the window.
   * Default `'head'`. The mode is not stored with the cursor: resuming a head-mode cursor in
   * final mode keeps the unfinalized blocks it already delivered.
   */
  readonly mode?: 'final' | 'head';
  /** Passed to the driver's block source; each entry is resolved on this chain and network. */
  readonly filter?: {
    readonly addresses?: readonly string[];
    readonly assets?: readonly (AssetRef | string)[];
  };
  /** Blocks retained for rollback detection (default: the network's reorgWindow). */
  readonly reorgWindow?: number;
  readonly pollIntervalMs?: number;
  /**
   * Stops the scan, also while it waits for new blocks. `iterator.return()` only takes effect
   * once a pending `next()` settles, so an idle scanner is stopped with this signal.
   */
  readonly signal?: AbortSignal;
}

export interface Checkpoint {
  readonly height: bigint;
  readonly hash: string;
}

/** A scan event without its `ack()`: a delivered block, or a rollback to a checkpoint. */
export type ScanEventBody =
  | {
      readonly type: 'block';
      readonly block: Block;
      readonly transactions: readonly Transaction[];
    }
  | {
      readonly type: 'rollback';
      readonly to: Checkpoint;
      readonly removed: readonly Checkpoint[];
    };

export type ScanEvent = ScanEventBody & { ack(): Promise<void> };

export interface ScannerDeps {
  readonly load: () => Promise<{
    readonly mapping: MappingContext;
    readonly blocks: BlockSource;
    /** The verified height watermark and lag tolerance behind the stale-view guard. */
    readonly transport: StaleViewSource;
  }>;
  readonly cursors: CursorStore;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly namespace: string;
  readonly defaults: { readonly reorgWindow: number; readonly pollIntervalMs: number };
}

interface Step {
  readonly event: ScanEventBody;
  readonly next: ScanCursor;
}

/** What one iteration of a scan reads through. */
interface Source {
  readonly mapping: MappingContext;
  readonly blocks: BlockSource;
  readonly transport: StaleViewSource;
  readonly window: number;
  readonly filter: ScanFilter | undefined;
}

const isAssetInput = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.length > 0
    : typeof value === 'object' &&
      value !== null &&
      typeof (value as { standard?: unknown }).standard === 'string' &&
      typeof (value as { contract?: unknown }).contract === 'string';

function assertFilter(filter: ScannerOptions['filter'], invalid: (m: string) => Error) {
  if (filter === undefined) return;
  if (typeof filter !== 'object' || filter === null)
    throw invalid('filter must be an object');
  const { addresses, assets } = filter;
  if (
    addresses !== undefined &&
    (!Array.isArray(addresses) || !addresses.every((a) => typeof a === 'string'))
  )
    throw invalid('filter.addresses must be an array of address strings');
  if (assets !== undefined && (!Array.isArray(assets) || !assets.every(isAssetInput)))
    throw invalid('filter.assets must be an array of asset refs or asset ids');
}

function assertOptions(options: ScannerOptions): void {
  const invalid = (message: string) =>
    new ConfigError('CONFIG_INVALID', `scanner ${message}`);
  const { cursorKey, from, mode, reorgWindow, pollIntervalMs } = options;
  assertFilter(options.filter, invalid);
  if (typeof cursorKey !== 'string' || cursorKey.length === 0)
    throw invalid('cursorKey must be a non-empty string');
  if (from !== undefined && from !== 'latest' && (typeof from !== 'bigint' || from < 0n))
    throw invalid("from must be 'latest' or a non-negative bigint height");
  if (mode !== undefined && mode !== 'final' && mode !== 'head')
    throw invalid("mode must be 'final' or 'head'");
  if (
    reorgWindow !== undefined &&
    (!Number.isSafeInteger(reorgWindow) || reorgWindow < 1)
  )
    throw invalid('reorgWindow must be a positive integer');
  if (
    pollIntervalMs !== undefined &&
    (typeof pollIntervalMs !== 'number' ||
      !Number.isFinite(pollIntervalMs) ||
      pollIntervalMs <= 0)
  )
    throw invalid('pollIntervalMs must be a finite number greater than 0');
}

/** The cursor's window; a reset checkpoint stored without one is its own window. */
function windowOf(cursor: ScanCursor): readonly Checkpoint[] {
  if (cursor.recent.length > 0 || cursor.height < 0n) return cursor.recent;
  return [{ height: cursor.height, hash: cursor.hash }];
}

function sameCursor(a: ScanCursor, b: ScanCursor): boolean {
  return (
    a.height === b.height &&
    a.hash === b.hash &&
    a.recent.length === b.recent.length &&
    a.recent.every(
      (r, i) => r.height === b.recent[i]?.height && r.hash === b.recent[i]?.hash,
    )
  );
}

/**
 * Reorg-aware, at-least-once block scanner (spec §10). Each event's `ack()` commits the
 * cursor (compare-and-set on its version, so two scanners sharing a `cursorKey` never both
 * commit the same advance); asking for the next event first throws `INVALID_TRANSITION`.
 * A view that cannot decide (stale, or missing a block) never causes a rollback: the
 * scanner waits a poll interval and looks again, as it does after a retryable provider error.
 *
 * A cursor stopped by `SCANNER_REORG_TOO_DEEP` is reset explicitly: scan under a new
 * `cursorKey`, or `put` a checkpoint `{ height, hash, recent }` for its key through the
 * `CursorStore`. A checkpoint without `recent` is validated on its own block, and its
 * reorg protection then rebuilds as blocks are delivered.
 */
export class Scanner implements AsyncIterable<ScanEvent> {
  constructor(
    private readonly deps: ScannerDeps,
    private readonly options: ScannerOptions,
  ) {
    assertOptions(options);
  }

  [Symbol.asyncIterator](): AsyncIterator<ScanEvent> {
    return this.run();
  }

  private async *run(): AsyncGenerator<ScanEvent> {
    const { signal } = this.options;
    const { mapping, blocks, transport } = await this.deps.load();
    const reader = mapping.driver.reader;
    const { chain, network } = mapping.selection;
    const key = `${this.deps.namespace}:${chain.id}:${network.id}:${this.options.cursorKey}`;
    const window = this.options.reorgWindow ?? this.deps.defaults.reorgWindow;
    // Resolved inside the loop, so a transient failure resolving filter.assets is retried.
    let source: Source | undefined;
    const poll = this.options.pollIntervalMs ?? this.deps.defaults.pollIntervalMs;
    const tip = () =>
      this.options.mode === 'final'
        ? reader.getFinalizedHeight()
        : reader.getBlockHeight();
    const stored = await this.deps.cursors.get(key);
    let version = stored?.version ?? null;
    let cursor = stored?.cursor;
    // A stored cursor is re-validated against the canonical chain before anything is emitted.
    let validated = stored === null;
    while (!signal?.aborted) {
      let step: Step | undefined;
      try {
        source ??= {
          mapping,
          blocks,
          transport,
          window,
          filter: await this.scanFilter(mapping),
        };
        cursor ??= await this.initialCursor(source, await tip());
        if (cursor) {
          const verdict = validated
            ? 'canonical'
            : await this.findRollback(source, cursor);
          validated = verdict !== undefined;
          step =
            verdict === 'canonical'
              ? await this.nextBlock(source, cursor, await tip())
              : verdict;
        }
      } catch (error) {
        // Like `watch`: a transient provider failure is retried on the next poll.
        if (signal?.aborted) return;
        if (!isCryptoAioError(error) || !error.retryable) throw error;
      }
      if (signal?.aborted) return;
      if (!step) {
        try {
          await this.deps.clock.sleep(poll, signal);
        } catch {
          return;
        }
        continue;
      }
      const { event, next } = step;
      let acked = false;
      let commit: Promise<void> | undefined;
      // Set once one of our puts for this event ended without a known outcome.
      let uncertain = false;
      const commitCursor = async (): Promise<void> => {
        try {
          version = await this.deps.cursors.put(key, next, version);
        } catch (error) {
          const conflict = isCryptoAioError(error, 'VERSION_CONFLICT');
          // A conflict may be our own put having landed only after one ended unseen (or when
          // the store says so); a first-try conflict is another scanner on this key.
          const recheck = conflict && (uncertain || error.ambiguous);
          const stored = recheck ? await this.deps.cursors.get(key) : null;
          if (!stored || !sameCursor(stored.cursor, next)) {
            if (!conflict) uncertain = true;
            throw error;
          }
          version = stored.version;
        }
        cursor = next;
        acked = true;
        this.emit(event);
      };
      yield {
        ...event,
        // Concurrent calls share one commit; a failed commit can be retried.
        ack: () =>
          (commit ??= commitCursor().catch((error: unknown) => {
            commit = undefined;
            throw error;
          })),
      };
      if (!acked) {
        throw new StateError(
          'INVALID_TRANSITION',
          'ack() the previous scan event before requesting the next one',
        );
      }
    }
  }

  /** Normalizes the filter on this chain and network (the driver's codec and asset service). */
  private async scanFilter(mapping: MappingContext): Promise<ScanFilter | undefined> {
    const { addresses, assets } = this.options.filter ?? {};
    if (addresses === undefined && assets === undefined) return undefined;
    const { selection, driver } = mapping;
    return {
      ...(addresses
        ? { addresses: addresses.map((a) => driver.address.normalize(a).canonical) }
        : {}),
      ...(assets
        ? {
            assets: await Promise.all(
              assets.map(
                async (a) => (await mapping.assets.resolve(selection, driver, a)).ref,
              ),
            ),
          }
        : {}),
    };
  }

  /**
   * A new cursor sits just below the start height and retains the `window` blocks beneath
   * it, so a reorg early in the scan is still resolvable. `undefined` (wait) while the
   * chain's tip for this mode is below the start's parent, or its blocks are not visible
   * as one consistent chain yet.
   */
  private async initialCursor(
    source: Source,
    tip: bigint,
  ): Promise<ScanCursor | undefined> {
    const from = this.options.from ?? 'latest';
    const start = from === 'latest' ? tip : from;
    if (start <= 0n) return { height: -1n, hash: '', recent: [] };
    if (start - 1n > tip) return undefined;
    const recent = await this.loadWindow(source, start - 1n, source.window);
    const top = recent?.[recent.length - 1];
    return recent && top && { height: top.height, hash: top.hash, recent };
  }

  /**
   * Up to `count` checkpoints ending at `height`, oldest first, read down the parent links;
   * with `hash`, the block at `height` must have it. `undefined` (wait) when a block is not
   * visible or the links do not hold.
   */
  private async loadWindow(
    source: Source,
    height: bigint,
    count: number,
    hash?: string,
  ): Promise<Checkpoint[] | undefined> {
    const loaded: Checkpoint[] = [];
    let expected = hash;
    for (let h = height; h >= 0n && loaded.length < count; h--) {
      const header = await source.blocks.header(h);
      if (!header || (expected !== undefined && header.hash !== expected))
        return undefined;
      loaded.unshift({ height: header.height, hash: header.hash });
      expected = header.parentHash;
    }
    return loaded;
  }

  /**
   * Extends a window that a rollback trimmed back down to `window` entries from the chain,
   * which is canonical at and below the common ancestor. `undefined` (wait) on a gap.
   */
  private async refill(
    source: Source,
    kept: readonly Checkpoint[],
  ): Promise<readonly Checkpoint[] | undefined> {
    const oldest = kept[0];
    if (!oldest || kept.length >= source.window || oldest.height === 0n) return kept;
    const missing = source.window - kept.length;
    const below = await this.loadWindow(source, oldest.height, missing + 1, oldest.hash);
    return below && [...below.slice(0, -1), ...kept];
  }

  private async nextBlock(
    source: Source,
    cursor: ScanCursor,
    tip: bigint,
  ): Promise<Step | undefined> {
    const height = cursor.height + 1n;
    if (height > tip) return undefined;
    const header = await source.blocks.header(height);
    if (!header) return undefined;
    if (cursor.height >= 0n && header.parentHash !== cursor.hash) {
      const verdict = await this.findRollback(source, cursor);
      // The cursor's block is still canonical, so the two reads disagreed: look again later.
      return verdict === 'canonical' ? undefined : verdict;
    }
    const transactions = await source.blocks.transactions(header, source.filter);
    const reader = source.mapping.driver.reader;
    const [head, finalized] = await Promise.all([
      reader.getBlockHeight(),
      reader.getFinalizedHeight(),
    ]);
    const mapped = await Promise.all(
      transactions.map((tx) => toTransaction(source.mapping, tx, head, finalized)),
    );
    const checkpoint = { height: header.height, hash: header.hash };
    return {
      event: { type: 'block', block: toBlock(header), transactions: mapped },
      next: {
        ...checkpoint,
        recent: [...windowOf(cursor), checkpoint].slice(-source.window),
      },
    };
  }

  /**
   * Walks the retained window newest-first to the common ancestor with the canonical chain.
   * Returns `'canonical'` when the cursor's own block still is, a rollback step when an older
   * block is, and `undefined` when this view cannot decide: it is stale, or it does not show
   * a block yet (absence is never divergence). Throws `SCANNER_REORG_TOO_DEEP` only when
   * every retained block is visible and none is canonical. The rolled-back cursor's window
   * is refilled from the chain below the ancestor. R33: a rollback or TOO_DEEP verdict of
   * this header walk stands only once the proof quorum confirms it.
   */
  private async findRollback(
    source: Source,
    cursor: ScanCursor,
  ): Promise<Step | 'canonical' | undefined> {
    if (cursor.height < 0n) return 'canonical';
    if (await this.staleView(source)) return undefined;
    const window = windowOf(cursor);
    const newestFirst = [...window].reverse();
    for (const [i, entry] of newestFirst.entries()) {
      const canonical = await source.blocks.header(entry.height);
      if (!canonical) return undefined;
      if (canonical.hash !== entry.hash) continue;
      if (i === 0) return 'canonical';
      if (!(await this.confirmed(source, newestFirst.slice(0, i), entry)))
        return undefined;
      const recent = await this.refill(
        source,
        window.filter((r) => r.height <= entry.height),
      );
      if (!recent) return undefined;
      return {
        event: { type: 'rollback', to: entry, removed: newestFirst.slice(0, i) },
        next: { height: entry.height, hash: entry.hash, recent },
      };
    }
    if (!(await this.confirmed(source, newestFirst))) return undefined;
    throw new StateError(
      'SCANNER_REORG_TOO_DEEP',
      `the chain diverged deeper than the ${source.window}-block window of cursor '${this.options.cursorKey}'; reset the cursor explicitly`,
    );
  }

  /**
   * R33: whether the quorum-served hashes confirm a verdict: every `removed` block has been
   * replaced at its height, and `ancestor` (when given) is still canonical. No block at a
   * height decides nothing (`false`); a quorum that disagrees throws a retryable error,
   * which the scan loop also treats as "look again later".
   */
  private async confirmed(
    source: Source,
    removed: readonly Checkpoint[],
    ancestor?: Checkpoint,
  ): Promise<boolean> {
    const { proofs } = source.mapping.driver;
    for (const entry of removed) {
      const hash = await proofs.blockHash(entry.height, 'latest');
      if (hash === null || hash === entry.hash) return false;
    }
    if (ancestor === undefined) return true;
    return (await proofs.blockHash(ancestor.height, 'latest')) === ancestor.hash;
  }

  /** The monitor's stale-view guard (`isStaleView`): a stale view decides nothing. */
  private async staleView(source: Source): Promise<boolean> {
    return isStaleView(
      source.transport,
      await source.mapping.driver.reader.getBlockHeight(),
    );
  }

  /** Operational data only: never addresses, amounts or hashes. */
  private emit(event: ScanEventBody): void {
    if (event.type === 'block') {
      this.deps.events.emit('scanner.block', {
        namespace: this.deps.namespace,
        cursorKey: this.options.cursorKey,
        height: event.block.height.toString(),
      });
    } else {
      this.deps.events.emit('scanner.rollback', {
        namespace: this.deps.namespace,
        cursorKey: this.options.cursorKey,
        toHeight: event.to.height.toString(),
        removed: event.removed.length,
      });
    }
  }
}
