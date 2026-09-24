import { toBlock, toTransaction, type MappingContext } from '../blockchain/mapping';
import type { BlockSource, ScanFilter } from '../driver/types';
import { ConfigError, StateError, isCryptoAioError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Block, Transaction } from '../model/transaction';
import type { CursorStore, ScanCursor } from '../store/types';
import type { Transport } from '../transport/types';
import type { Clock } from '../util/clock';

export interface ScannerOptions {
  /** Durable name of this consumer's position (namespaced per container, chain and network). */
  readonly cursorKey: string;
  /** Where a NEW cursor starts; ignored when a stored cursor exists. Default `'latest'`. */
  readonly from?: 'latest' | bigint;
  /** `'final'` emits finalized blocks only (no rollbacks); `'head'` follows the tip. Default `'head'`. */
  readonly mode?: 'final' | 'head';
  readonly filter?: { readonly addresses?: readonly string[] };
  /** Blocks retained for rollback detection (default: the network's reorgWindow). */
  readonly reorgWindow?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface Checkpoint {
  readonly height: bigint;
  readonly hash: string;
}

type ScanEventBody =
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
    /** The verified height watermark behind the stale-view guard. */
    readonly transport: Pick<Transport, 'highestHeight' | 'hasProbes'>;
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
  readonly transport: Pick<Transport, 'highestHeight' | 'hasProbes'>;
  readonly window: number;
  readonly filter: ScanFilter | undefined;
}

function assertOptions(options: ScannerOptions): void {
  const invalid = (message: string) =>
    new ConfigError('CONFIG_INVALID', `scanner ${message}`);
  const { cursorKey, from, mode, reorgWindow, pollIntervalMs } = options;
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

/**
 * Reorg-aware, at-least-once block scanner (spec §10). Each event's `ack()` commits the
 * cursor (compare-and-set on its version, so two scanners sharing a `cursorKey` never both
 * commit the same advance); asking for the next event first throws `INVALID_TRANSITION`.
 * A view that cannot decide (stale, or missing a block) never causes a rollback: the
 * scanner waits a poll interval and looks again, as it does after a retryable provider error.
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
    const addresses = this.options.filter?.addresses;
    const source: Source = {
      mapping,
      blocks,
      transport,
      window: this.options.reorgWindow ?? this.deps.defaults.reorgWindow,
      filter: addresses
        ? {
            addresses: addresses.map(
              (a) => mapping.driver.address.normalize(a).canonical,
            ),
          }
        : undefined,
    };
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
      const commitCursor = async (): Promise<void> => {
        version = await this.deps.cursors.put(key, next, version);
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
    const recent: Checkpoint[] = [];
    let childParent: string | undefined;
    for (
      let height = start - 1n;
      height >= 0n && recent.length < source.window;
      height--
    ) {
      const header = await source.blocks.header(height);
      if (!header || (childParent !== undefined && header.hash !== childParent))
        return undefined;
      recent.unshift({ height: header.height, hash: header.hash });
      childParent = header.parentHash;
    }
    const top = recent[recent.length - 1] as Checkpoint;
    return { height: top.height, hash: top.hash, recent };
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
        recent: [...cursor.recent, checkpoint].slice(-source.window),
      },
    };
  }

  /**
   * Walks the retained window newest-first to the common ancestor with the canonical chain.
   * Returns `'canonical'` when the cursor's own block still is, a rollback step when an older
   * block is, and `undefined` when this view cannot decide: it is stale, or it does not show
   * a block yet (absence is never divergence). Throws `SCANNER_REORG_TOO_DEEP` only when
   * every retained block is visible and none is canonical.
   */
  private async findRollback(
    source: Source,
    cursor: ScanCursor,
  ): Promise<Step | 'canonical' | undefined> {
    if (cursor.height < 0n) return 'canonical';
    if (await this.staleView(source)) return undefined;
    const newestFirst = [...cursor.recent].reverse();
    for (const [i, entry] of newestFirst.entries()) {
      const canonical = await source.blocks.header(entry.height);
      if (!canonical) return undefined;
      if (canonical.hash !== entry.hash) continue;
      if (i === 0) return 'canonical';
      return {
        event: { type: 'rollback', to: entry, removed: newestFirst.slice(0, i) },
        next: {
          height: entry.height,
          hash: entry.hash,
          recent: cursor.recent.filter((r) => r.height <= entry.height),
        },
      };
    }
    throw new StateError(
      'SCANNER_REORG_TOO_DEEP',
      `the chain diverged deeper than the ${source.window}-block window of cursor '${this.options.cursorKey}'; reset the cursor explicitly`,
    );
  }

  /**
   * The monitor's stale-view guard: a head more than the lag tolerance behind the transport's
   * verified height, or no verified height at all while health probes exist, decides nothing.
   */
  private async staleView(source: Source): Promise<boolean> {
    const head = await source.mapping.driver.reader.getBlockHeight();
    const highest = source.transport.highestHeight();
    if (highest === undefined) return source.transport.hasProbes();
    const tolerance = BigInt(source.mapping.selection.network.maxLagBlocks ?? 5);
    return head + tolerance < highest;
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
