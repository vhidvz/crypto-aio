import { statusFromObservation } from '../blockchain/mapping';
import type { ProofSource } from '../driver/types';
import {
  ChainError,
  ConfigError,
  StateError,
  TimeoutError,
  ValidationError,
  isCryptoAioError,
  type SerializedError,
} from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import type { TxStatus } from '../model/transaction';
import {
  NON_TERMINAL_STATES,
  isTerminal,
  type AttemptObservation,
  type AttemptRecord,
  type ClearableField,
  type Fence,
  type OperationClaim,
  type OperationPatch,
  type OperationRecord,
  type Stores,
} from '../store/types';
import { randomId } from '../util/bytes';
import type { Clock } from '../util/clock';
import {
  PRE_SIGNING_STATES,
  errorCode,
  rehydrateError,
  type OperationEngine,
  type OperationTarget,
  type ReadTarget,
  type ResolvedLifecycle,
} from './engine';
import { evaluateOperation } from './evaluate';
import {
  loadObservations,
  writeObservation,
  type ObservationDeps,
  type ObservationPatch,
} from './observations';
import { statusOf, type OperationView } from './views';

export interface WaitOptions {
  /** Default: the handle's `confirmations`. Ignored when `finality: 'final'`. */
  readonly confirmations?: number;
  readonly finality?: 'included' | 'final';
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface ConfirmationResult {
  readonly status: TxStatus;
  readonly operation?: OperationView;
}

export interface TxStatusEvent {
  readonly status: TxStatus;
  readonly operation?: OperationView;
}

/**
 * What `recover()` did. The counts are per Operation, except `reconciled`, and they
 * overlap: an Operation whose resend was attempted and whose check then failed counts in
 * both `rebroadcast` and `failed`.
 */
export interface RecoveryReport {
  /**
   * `signed` or ambiguously `submitted` Operations whose stored bytes were sent again:
   * attempted resends, including ones the node refused or whose outcome is unknown.
   */
  readonly rebroadcast: number;
  /** Operations checked on chain after any resend. */
  readonly checked: number;
  /** Operations that need a caller (see `recovery.skipped`); never resent or checked. */
  readonly skipped: number;
  /** Operations whose target could not be rebuilt, or whose resend or check threw. */
  readonly failed: number;
  /** Leaked nonce values that reconciliation returned for reuse (across all wallets). */
  readonly reconciled: number;
}

export interface WorkerOptions {
  /** Default: a random id per `start` call. */
  readonly workerId?: string;
  readonly signal?: AbortSignal;
  /** How many due Operations one pass claims. Default: 50. */
  readonly batch?: number;
}

const DEFAULT_BATCH = 50;
/** How many Operations' reported gaps a monitor remembers (`nonce.gap` is at-least-once). */
const GAP_MEMORY = 10_000;

/**
 * Rebuilds the wallet-bound target of a stored Operation (from its `context`); `undefined`
 * (or a rejection) when it cannot be resolved any more, e.g. its wallet config is gone.
 */
export type TargetResolver = (
  op: OperationRecord,
) => Promise<OperationTarget | undefined>;

export interface MonitorDeps {
  readonly engine: OperationEngine;
  readonly stores: Stores;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly namespace: string;
  readonly lifecycle: () => ResolvedLifecycle;
  /** R26.3: reservation-holding verdicts are applied by the engine on this target. */
  readonly resolveTarget: TargetResolver;
}

interface Snapshot {
  readonly status: TxStatus;
  readonly record?: OperationRecord;
}

const SETTLED = new Set(['final', 'failed', 'rejected', 'replaced', 'expired']);
const UNKNOWN: TxStatus = {
  state: 'unknown',
  evidence: 'observed',
  confirmations: 0,
  finality: 'none',
};

/** Proven and settled: nothing observed later may overwrite it (R25). */
function isSettled(observation: AttemptObservation | null | undefined): boolean {
  return observation?.evidence === 'proven' && SETTLED.has(observation.state);
}

/**
 * Watches Attempts on chain and moves their Operation on evidence (spec §6.7, §8.8).
 * Observed data (a single endpoint's view, absence, `dropped`, `refused`, an unfinalized
 * block) only ever produces non-terminal states; a terminal state needs `proven` evidence
 * (finalized data confirmed by quorum proof reads). A stale view decides nothing.
 */
export class Monitor {
  /**
   * Per Operation, the expected nonces a `nonce.gap` was already emitted for; least
   * recently reported first, capped at `GAP_MEMORY` Operations (M2).
   */
  readonly #gaps = new Map<string, Set<string>>();

  constructor(private readonly deps: MonitorDeps) {}

  private get observationDeps(): ObservationDeps {
    return {
      operations: this.deps.stores.operations,
      events: this.deps.events,
      namespace: this.deps.namespace,
    };
  }

  /** Finds a managed Operation by id, Attempt ref or observed canonical tx hash. */
  async find(ref: string): Promise<OperationRecord | null> {
    const store = this.deps.stores.operations;
    return (
      (await store.get(this.deps.namespace, ref)) ??
      (await store.findByRef(this.deps.namespace, ref))
    );
  }

  /**
   * One evaluation pass: observe live Attempts, persist observations, apply the transition.
   * `signal` (M4) is checked before every read, so an aborted pass stops after at most the
   * read in flight; it then throws the signal's reason and decides nothing further.
   */
  async check(
    target: ReadTarget,
    op: OperationRecord,
    fence?: Fence,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    return (await this.#checkPass(target, op, fence, signal)).record;
  }

  /** `check`, also telling whether the view was stale (it then decided nothing). */
  async #checkPass(
    target: ReadTarget,
    op: OperationRecord,
    fence?: Fence,
    signal?: AbortSignal,
  ): Promise<{ readonly record: OperationRecord; readonly stale: boolean }> {
    if (isTerminal(op.state) || PRE_SIGNING_STATES.has(op.state))
      return { record: op, stale: false };
    const { pooled } = target;
    signal?.throwIfAborted();
    await pooled.transport.ensureFreshHealth(signal);
    signal?.throwIfAborted();
    const [head, finalized] = await Promise.all([
      pooled.driver.reader.getBlockHeight(),
      pooled.driver.reader.getFinalizedHeight(),
    ]);
    const highest = pooled.transport.highestHeight();
    const tolerance = BigInt(target.selection.network.maxLagBlocks ?? 5);
    // Controller amendment (carry-forward): when probes are configured, an unknown verified
    // height means the view cannot be judged, so decide nothing.
    if (highest === undefined ? pooled.transport.hasProbes() : head + tolerance < highest)
      return { record: op, stale: true }; // stale view: decide nothing
    const observations = new Map<string, AttemptObservation>();
    for (const attempt of op.attempts) {
      try {
        observations.set(
          attempt.id,
          await this.observeAttempt(target, op, attempt, head, finalized, signal),
        );
      } catch (error) {
        if (signal?.aborted || !isCryptoAioError(error) || !error.retryable) throw error;
        const current = await this.deps.stores.operations.getObservation(attempt.id);
        if (current) observations.set(attempt.id, current);
      }
    }
    return {
      record: await this.applyEvaluation(op, observations, fence, signal),
      stale: false,
    };
  }

  /** Current status of a managed Operation (after a check) or of an arbitrary transaction id. */
  async status(target: ReadTarget, ref: string, signal?: AbortSignal): Promise<Snapshot> {
    let record = await this.find(ref);
    if (!record) return { status: await this.rawStatus(target, ref) };
    this.assertSameNetwork(target, record);
    if (!isTerminal(record.state) && !PRE_SIGNING_STATES.has(record.state)) {
      try {
        record = await this.check(target, record, undefined, signal);
      } catch (error) {
        if (signal?.aborted || !isCryptoAioError(error) || !error.retryable) throw error;
      }
    }
    const observations = await loadObservations(this.deps.stores.operations, record);
    return { status: this.bestStatus(record, observations), record };
  }

  /**
   * Polls until the wanted status: `confirmations` (default: the handle's) or, with
   * `finality: 'final'`, proven finality for a managed Operation and observed finality for
   * a transaction it does not manage. M4: the caller's `signal` and the deadline bound
   * every pass and sleep; a pass stops after at most the read in flight.
   */
  async waitFor(
    target: ReadTarget,
    ref: string,
    options: WaitOptions = {},
  ): Promise<Snapshot> {
    const { signal } = options;
    if (signal?.aborted) throw signal.reason;
    const lifecycle = this.deps.lifecycle();
    const deadline =
      this.deps.clock.now() + (options.timeoutMs ?? lifecycle.waitTimeoutMs);
    const poll = options.pollIntervalMs ?? lifecycle.pollIntervalMs;
    const wanted = options.confirmations ?? target.selection.confirmations;
    const wantFinal = options.finality === 'final';
    let last: Snapshot | undefined;
    const stopped = (): unknown =>
      signal?.aborted
        ? signal.reason
        : new TimeoutError(
            'TIMEOUT',
            'the transaction was not confirmed before the timeout',
            {
              context: last?.record ? { operationId: last.record.id } : {},
            },
          );
    // One signal for every pass and sleep: the caller's abort or the deadline.
    const bound = new AbortController();
    const finished = new AbortController();
    const onAbort = () => bound.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.deps.clock
      .sleep(Math.max(0, deadline - this.deps.clock.now()), finished.signal)
      .then(onAbort, () => undefined);
    try {
      for (;;) {
        if (bound.signal.aborted || this.deps.clock.now() >= deadline) throw stopped();
        let snapshot: Snapshot | undefined;
        try {
          snapshot = await this.status(target, ref, bound.signal);
        } catch (error) {
          if (bound.signal.aborted) throw stopped();
          if (!isCryptoAioError(error) || !error.retryable) throw error;
        }
        if (snapshot) {
          last = snapshot;
          const { status, record } = snapshot;
          if (record?.state === 'final') return snapshot;
          if (record && (record.state === 'failed' || record.state === 'expired')) {
            throw rehydrateError(record.error ?? this.defaultError(record), record.id);
          }
          if (record?.state === 'abandoned') {
            throw new StateError(
              'INVALID_TRANSITION',
              `operation '${record.id}' was abandoned`,
            );
          }
          if (!record && status.state === 'failed' && status.finality === 'final') {
            throw new ChainError(
              'TX_REVERTED',
              'the transaction was included but failed on chain',
            );
          }
          const reached = wantFinal
            ? status.state === 'final' || unmanagedFinal(snapshot)
            : status.state === 'final' ||
              (status.state === 'included' && status.confirmations >= wanted);
          if (reached) return snapshot;
        }
        try {
          await this.deps.clock.sleep(poll, bound.signal);
        } catch {
          throw stopped();
        }
      }
    } finally {
      finished.abort();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Yields each status change until the Operation is terminal, or (I3) until a transaction
   * it does not manage reaches observed finality, whether it succeeded or reverted. Ends
   * quietly when `signal` aborts.
   */
  async *watch(
    target: ReadTarget,
    ref: string,
    options: { readonly pollIntervalMs?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<Snapshot> {
    const { signal } = options;
    const poll = options.pollIntervalMs ?? this.deps.lifecycle().pollIntervalMs;
    let last = '';
    while (!signal?.aborted) {
      let snapshot: Snapshot | undefined;
      try {
        snapshot = await this.status(target, ref, signal);
      } catch (error) {
        if (signal?.aborted) return;
        if (!isCryptoAioError(error) || !error.retryable) throw error;
      }
      if (snapshot) {
        const { status, record } = snapshot;
        const key = [
          status.state,
          status.evidence,
          status.confirmations,
          status.blockHash ?? '',
          record?.state ?? '',
        ].join('|');
        if (key !== last) {
          last = key;
          yield snapshot;
        }
        if (record ? isTerminal(record.state) : unmanagedFinal(snapshot)) return;
      }
      try {
        await this.deps.clock.sleep(poll, signal);
      } catch {
        return;
      }
    }
  }

  // ---- workers and recovery ------------------------------------------------------------

  /**
   * One worker pass: claims up to `batch` due Operations, checks each under its claim fence
   * (a stale worker's writes fail), then releases the claim. R26: every claimed Operation
   * that stays live leaves the pass scheduled a poll interval ahead, including when its
   * check threw, its view was stale or its all-rejected verdict could not run, so no worker
   * claims it again before then. A stale view also skips gap handling and reconciliation.
   * `signal` bounds each check and its lease wait; once it aborts, the Operations not yet
   * checked are only released, still due, for another worker. Returns how many Operations
   * it claimed.
   */
  async runOnce(options: {
    readonly workerId: string;
    readonly batch?: number;
    readonly signal?: AbortSignal;
  }): Promise<number> {
    const { signal } = options;
    const claimed = await this.deps.stores.operations.claimDue(
      this.deps.namespace,
      options.workerId,
      this.deps.clock.now(),
      this.deps.lifecycle().claimLeaseMs,
      options.batch ?? DEFAULT_BATCH,
    );
    const resolve = this.#passResolver();
    for (const op of claimed) {
      const fence: Fence = { claimToken: (op.claim as OperationClaim).token };
      if (!signal?.aborted) await this.#process(resolve, op, fence, signal);
      await this.deps.stores.operations
        .releaseClaim(this.deps.namespace, op.id, fence)
        .catch((error: unknown) =>
          this.deps.log.debug('claim already lost', {
            operationId: op.id,
            code: errorCode(error),
          }),
        );
    }
    return claimed.length;
  }

  /** One claimed Operation of a worker pass (see `runOnce`). */
  async #process(
    resolve: TargetResolver,
    op: OperationRecord,
    fence: Fence,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const started = this.deps.clock.now();
    let current: OperationRecord | undefined;
    try {
      const target = await this.#targetOf(resolve, op);
      const pass = await this.#checkPass(target, op, fence, signal);
      current = pass.record;
      if (!pass.stale) await this.#detectNonceGap(target, current);
    } catch (error) {
      this.deps.log.warn('monitor check failed', {
        operationId: op.id,
        code: errorCode(error),
      });
    }
    const scheduled =
      current !== undefined &&
      (isTerminal(current.state) ||
        (current.nextCheckAt !== undefined && current.nextCheckAt > started));
    if (!scheduled) await this.#reschedule(op.id, fence, started);
  }

  /**
   * Runs worker passes until `signal` aborts. Any number of workers, in any number of
   * processes, may run: claims keep them apart. A full batch is followed by the next pass at
   * once, anything less by a poll-interval sleep. A failed pass (e.g. a store outage) is
   * logged by code and retried after the sleep.
   */
  async start(options: WorkerOptions = {}): Promise<void> {
    const workerId = options.workerId ?? randomId('worker');
    const batch = options.batch ?? DEFAULT_BATCH;
    const { signal } = options;
    while (!signal?.aborted) {
      let processed = 0;
      try {
        processed = await this.runOnce({
          workerId,
          batch,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        this.deps.log.warn('monitor worker pass failed', {
          workerId,
          code: errorCode(error),
        });
      }
      if (processed > 0 && processed >= batch) continue;
      try {
        await this.deps.clock.sleep(this.deps.lifecycle().pollIntervalMs, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * Startup recovery for this namespace; it never signs. `signed` and ambiguously
   * `submitted` Operations resend their stored raw bytes; every other signed-or-later live
   * Operation is checked. `created`, `prepared`, `awaiting-signature` and `stalled` ones need
   * a caller and are reported through `recovery.skipped` (codes and states only). Then each
   * wallet with a live Operation has its nonces reconciled under its address lease. A
   * failure is logged by code and counted, and the rest go on. `signal` stops recovery
   * between Operations and bounds each check and lease wait.
   */
  async recover(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RecoveryReport> {
    const { signal } = options;
    const { namespace } = this.deps;
    const live = await this.deps.stores.operations.list({
      namespace,
      states: NON_TERMINAL_STATES,
    });
    const resolve = this.#passResolver();
    let rebroadcast = 0;
    let checked = 0;
    let skipped = 0;
    let failed = 0;
    let reconciled = 0;
    const skip = (op: OperationRecord, reason: string) => {
      skipped += 1;
      this.deps.events.emit('recovery.skipped', {
        namespace,
        operationId: op.id,
        state: op.state,
        reason,
      });
    };
    for (const op of live) {
      if (signal?.aborted) break;
      if (PRE_SIGNING_STATES.has(op.state)) {
        skip(op, 'CALLER_ACTION_REQUIRED');
        continue;
      }
      if (op.state === 'stalled') {
        skip(op, 'STALLED');
        continue;
      }
      try {
        const target = await this.#targetOf(resolve, op);
        let current = op;
        if (
          op.state === 'signed' ||
          (op.state === 'submitted' && op.ambiguous === true)
        ) {
          try {
            current = await this.deps.engine.rebroadcast(target, op.id);
          } catch (error) {
            // A refusal or an unknown outcome is recorded on the Operation: check it next.
            if (
              !isCryptoAioError(error) ||
              (error.category !== 'chain' && error.ambiguous !== true)
            )
              throw error;
            current = (await this.find(op.id)) ?? op;
          }
          rebroadcast += 1;
        }
        await this.check(target, current, undefined, signal);
        checked += 1;
      } catch (error) {
        failed += 1;
        this.deps.log.warn('recovery of an operation failed', {
          operationId: op.id,
          code: errorCode(error),
        });
      }
    }
    const wallets = new Map<string, OperationRecord>();
    for (const op of live) {
      const key = [op.context.chain, op.context.network, op.intent.from].join('\n');
      if (!wallets.has(key)) wallets.set(key, op);
    }
    for (const op of wallets.values()) {
      if (signal?.aborted) break;
      try {
        const target = await this.#targetOf(resolve, op);
        reconciled += (await this.deps.engine.reconcileNonces(target, op, { signal }))
          .length;
      } catch (error) {
        this.deps.log.warn('nonce reconciliation failed', {
          operationId: op.id,
          code: errorCode(error),
        });
      }
    }
    return { rebroadcast, checked, skipped, failed, reconciled };
  }

  /** The resolver for one pass: each execution context's target is rebuilt once. */
  #passResolver(): TargetResolver {
    const targets = new Map<string, Promise<OperationTarget | undefined>>();
    return (op) => {
      let target = targets.get(op.context.configHash);
      if (!target) {
        target = this.deps.resolveTarget(op);
        targets.set(op.context.configHash, target);
      }
      return target;
    };
  }

  async #targetOf(
    resolve: TargetResolver,
    op: OperationRecord,
  ): Promise<OperationTarget> {
    const target = await resolve(op);
    if (!target) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `the target of operation '${op.id}' cannot be rebuilt from its context`,
      );
    }
    return target;
  }

  /**
   * R26: leaves a claimed, live Operation scheduled a poll interval ahead, unless it ended,
   * another worker took it over or a writer scheduled it meanwhile. A pre-signing Operation
   * is never scheduled (callers drive it), so it is unscheduled instead. Best effort.
   */
  async #reschedule(id: string, fence: Fence, started: number): Promise<void> {
    try {
      for (let tries = 0; tries < 3; tries++) {
        const fresh = await this.deps.stores.operations.get(this.deps.namespace, id);
        if (
          !fresh ||
          isTerminal(fresh.state) ||
          fresh.claim?.token !== fence.claimToken ||
          (fresh.nextCheckAt !== undefined && fresh.nextCheckAt > started)
        )
          return;
        const patch: OperationPatch = PRE_SIGNING_STATES.has(fresh.state)
          ? { clear: ['nextCheckAt'] }
          : { nextCheckAt: this.deps.clock.now() + this.deps.lifecycle().pollIntervalMs };
        try {
          await this.deps.engine.update(fresh, patch, fence);
          return;
        } catch (error) {
          if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
        }
      }
    } catch (error) {
      this.deps.log.debug('could not reschedule a claimed operation', {
        operationId: id,
        code: errorCode(error),
      });
    }
  }

  /**
   * `nonce.gap`, once per (Operation, expected nonce): a `submitted` Operation has waited
   * longer than `droppedGracePeriodMs` since its active Attempt was first seen or sent, and
   * the chain's pending nonce is still below its own (spec §8.5: a lower nonce is missing
   * even from the mempool, so congestion alone is no gap). It names the live Operation
   * holding the expected nonce, when one exists. Every such pass then reconciles the wallet's nonces, trying the lease
   * once (never a filler transaction): a leaked value goes back for the next transfer.
   */
  async #detectNonceGap(target: OperationTarget, op: OperationRecord): Promise<void> {
    const { sequence } = target.pooled.driver;
    if (op.state !== 'submitted' || op.reservation?.kind !== 'nonce' || !sequence) {
      this.#gaps.delete(op.id);
      return;
    }
    const attempt = op.attempts.find((a) => a.id === op.activeAttemptId);
    const observation = attempt
      ? await this.deps.stores.operations.getObservation(attempt.id)
      : null;
    // M3: not `lastBroadcastAt`, which every resend of a dropped Attempt refreshes.
    const since = observation?.firstSeenAt ?? attempt?.createdAt ?? op.createdAt;
    if (this.deps.clock.now() - since < this.deps.lifecycle().droppedGracePeriodMs)
      return;
    const expected = await sequence.pending(op.intent.from);
    if (expected >= op.reservation.nonce) return;
    const reported = this.#gaps.get(op.id) ?? new Set<string>();
    this.#gaps.delete(op.id);
    this.#gaps.set(op.id, reported);
    if (this.#gaps.size > GAP_MEMORY) {
      const oldest = this.#gaps.keys().next().value;
      if (oldest !== undefined) this.#gaps.delete(oldest);
    }
    if (!reported.has(expected.toString())) {
      reported.add(expected.toString());
      const blocking = (
        await this.deps.stores.operations.list({
          namespace: this.deps.namespace,
          chain: op.context.chain,
          network: op.context.network,
          from: op.intent.from,
          states: NON_TERMINAL_STATES,
        })
      ).find((o) => o.reservation?.kind === 'nonce' && o.reservation.nonce === expected);
      this.deps.events.emit('nonce.gap', {
        namespace: this.deps.namespace,
        chain: op.context.chain,
        network: op.context.network,
        operationId: op.id,
        expected: expected.toString(),
        ...(blocking ? { blockingOperationId: blocking.id } : {}),
      });
    }
    try {
      await this.deps.engine.reconcileNonces(target, op, { acquireTimeoutMs: 0 });
    } catch (error) {
      const busy = isCryptoAioError(error, 'SEQUENCE_BUSY');
      this.deps.log[busy ? 'debug' : 'warn']('nonce reconciliation did not run', {
        operationId: op.id,
        code: errorCode(error),
      });
    }
  }

  // ---- observation ---------------------------------------------------------------------

  private async observeAttempt(
    target: ReadTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    head: bigint,
    finalized: bigint,
    signal?: AbortSignal,
  ): Promise<AttemptObservation> {
    const current = await this.deps.stores.operations.getObservation(attempt.id);
    if (current && isSettled(current)) return current;
    const { driver } = target.pooled;
    const from = op.intent.from;
    const now = this.deps.clock.now();
    signal?.throwIfAborted();
    const seen = await driver.reader.observe(attempt.ref, attempt.ordering, from);
    signal?.throwIfAborted();
    let reorgedFrom: string | undefined;
    let patch: ObservationPatch;
    if (seen.seen === 'block' && seen.blockHeight !== undefined) {
      // The transaction is in another block than recorded: its old block was orphaned.
      if (
        current?.blockHash !== undefined &&
        seen.blockHash !== undefined &&
        current.blockHash !== seen.blockHash
      ) {
        reorgedFrom = current.blockHash;
      }
      patch = {
        state: seen.success === false ? 'failed' : 'included',
        evidence: 'observed',
        confirmations: depth(head, seen.blockHeight),
        blockHeight: seen.blockHeight,
        blockHash: seen.blockHash,
        ...(seen.txHash !== undefined ? { txHash: seen.txHash } : {}),
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: now,
      };
      if (seen.blockHeight <= finalized)
        patch = await this.proveFinal(target, op, attempt, patch, head, signal);
    } else {
      if (current?.blockHash !== undefined) {
        // Absence (or a mempool sighting) of an included transaction is not evidence of a
        // reorg by itself: a lagging or inconsistent endpoint shows the same. Only a
        // different block at the recorded height proves it; otherwise decide nothing.
        if (!(await this.orphaned(target, current))) return current;
        signal?.throwIfAborted();
        reorgedFrom = current.blockHash;
      }
      const cleared: ObservationPatch = {
        blockHash: undefined,
        blockHeight: undefined,
        confirmations: 0,
      };
      patch =
        seen.seen === 'mempool'
          ? {
              ...cleared,
              state: 'mempool',
              evidence: 'observed',
              firstSeenAt: current?.firstSeenAt ?? now,
              lastSeenAt: now,
            }
          : {
              ...cleared,
              ...(await this.whenAbsent(target, op, attempt, current, now, signal)),
            };
    }
    // R25: this patch was derived from `current`; when another writer changed the
    // observation meanwhile (possibly with stronger evidence), keep theirs and decide nothing.
    let applied = false;
    const saved = await writeObservation(
      this.observationDeps,
      attempt,
      op.id,
      (stored) => {
        applied = (stored?.version ?? null) === (current?.version ?? null);
        return applied ? patch : undefined;
      },
    );
    if (!applied) return saved;
    if (reorgedFrom !== undefined) this.#reorged(op, attempt, reorgedFrom);
    if (
      saved.state === 'dropped' &&
      attempt.id === op.activeAttemptId &&
      op.state !== 'stalled'
    ) {
      signal?.throwIfAborted();
      await this.#rebroadcastDropped(target, op, attempt, saved, now);
    }
    return saved;
  }

  /**
   * A block at or below the finalized height becomes `final`/`failed` + `proven` only when
   * the quorum proof confirms it. A retryable proof failure (e.g. PROVIDER_INCONSISTENT)
   * decides nothing: the observed patch is kept.
   */
  private async proveFinal(
    target: ReadTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    patch: ObservationPatch,
    head: bigint,
    signal?: AbortSignal,
  ): Promise<ObservationPatch> {
    let proof: Awaited<ReturnType<ProofSource['includedFinal']>>;
    signal?.throwIfAborted();
    try {
      proof = await target.pooled.driver.proofs.includedFinal(
        attempt.ref,
        attempt.ordering,
        op.intent.from,
      );
    } catch (error) {
      if (!isCryptoAioError(error) || !error.retryable) throw error;
      return patch;
    }
    if (!proof.included) return patch;
    return {
      ...patch,
      state: proof.success ? 'final' : 'failed',
      evidence: 'proven',
      blockHeight: proof.blockHeight,
      blockHash: proof.blockHash,
      txHash: proof.txHash,
      confirmations: depth(head, proof.blockHeight),
    };
  }

  /** Whether the block recorded for `observation` is no longer the one at its height. */
  private async orphaned(
    target: ReadTarget,
    observation: AttemptObservation,
  ): Promise<boolean> {
    if (observation.blockHeight === undefined) return false;
    const block = await target.pooled.driver.reader.getBlock(observation.blockHeight);
    return block !== null && block.hash !== observation.blockHash;
  }

  /** The transaction is not visible anywhere we can see: only finalized proofs may declare it dead. */
  private async whenAbsent(
    target: ReadTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    current: AttemptObservation | null,
    now: number,
    signal?: AbortSignal,
  ): Promise<ObservationPatch> {
    const { proofs } = target.pooled.driver;
    const read = <T>(work: () => Promise<T>): Promise<T> => {
      signal?.throwIfAborted();
      return work();
    };
    // The built ordering (carry-forward: never the reservation, whose seqno `validUntil`
    // the driver may have replaced while building).
    const ordering = attempt.ordering;
    const from = op.intent.from;
    const slotted =
      ordering.kind === 'nonce' ||
      ordering.kind === 'seqno' ||
      ordering.kind === 'inputs';
    const expiring = ordering.kind === 'expiry' || ordering.kind === 'seqno';
    const deadSlot =
      slotted && (await read(() => proofs.slotConsumed(ordering, from, 'finalized')));
    const deadExpiry =
      !deadSlot && expiring && (await read(() => proofs.expired(ordering)));
    if (deadSlot || deadExpiry) {
      const proof = await read(() => proofs.includedFinal(attempt.ref, ordering, from));
      if (proof.included) {
        return {
          state: proof.success ? 'final' : 'failed',
          evidence: 'proven',
          blockHeight: proof.blockHeight,
          blockHash: proof.blockHash,
          txHash: proof.txHash,
        };
      }
      return { state: deadSlot ? 'replaced' : 'expired', evidence: 'proven' };
    }
    if (slotted && (await read(() => proofs.slotConsumed(ordering, from, 'latest')))) {
      return { state: 'replaced', evidence: 'observed' };
    }
    if (current?.state === 'refused') return { state: 'refused', evidence: 'observed' };
    const since = current?.lastSeenAt ?? current?.lastBroadcastAt ?? attempt.createdAt;
    const dropped = now - since >= this.deps.lifecycle().droppedGracePeriodMs;
    return { state: dropped ? 'dropped' : 'pending', evidence: 'observed' };
  }

  private async applyEvaluation(
    op: OperationRecord,
    observations: ReadonlyMap<string, AttemptObservation>,
    fence?: Fence,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const evaluation = evaluateOperation(op, observations);
    const { winner } = evaluation;
    if (winner) {
      // The winner consumed the ordering slot: every other Attempt is proven replaced by it.
      const linked = (o: AttemptObservation | null | undefined) =>
        isSettled(o) && !(o?.state === 'replaced' && o.replacedBy === undefined);
      for (const attempt of op.attempts) {
        if (attempt.id === winner.id || linked(observations.get(attempt.id))) continue;
        await writeObservation(this.observationDeps, attempt, op.id, (stored) =>
          linked(stored)
            ? undefined
            : { state: 'replaced', evidence: 'proven', replacedBy: winner.ref.id },
        );
      }
    }
    // R26.3: failing an all-rejected Operation releases its nonce, so the engine applies it
    // under the address lease; the monitor never makes a reservation-holding transition.
    if (evaluation.error?.code === 'TX_REJECTED')
      return this.failRejected(op, signal, fence);
    const terminal = isTerminal(evaluation.state);
    // R26.1: a read-only pass (no fence) writes the Operation only when its state, outcome
    // or error changes, never just to schedule it: a version bump would make a concurrent
    // engine write (e.g. right after a broadcast) lose its compare-and-set. Scheduling
    // (`nextCheckAt`) belongs to fenced workers and to engine transitions.
    const changed =
      evaluation.state !== op.state ||
      (evaluation.outcome !== undefined && evaluation.outcome !== op.outcome) ||
      (evaluation.error !== undefined && evaluation.error.code !== op.error?.code);
    if (!changed && !fence) return op;
    const clear: ClearableField[] = [];
    if (terminal) clear.push('nextCheckAt');
    if (op.state === 'stalled' && evaluation.state !== 'stalled' && !evaluation.error)
      clear.push('error');
    const patch: OperationPatch = {
      ...(evaluation.state !== op.state ? { state: evaluation.state } : {}),
      ...(evaluation.outcome ? { outcome: evaluation.outcome } : {}),
      ...(evaluation.error
        ? {
            error: new ChainError(evaluation.error.code, evaluation.error.message, {
              context: { operationId: op.id },
            }).toJSON(),
          }
        : {}),
      ...(fence && !terminal
        ? { nextCheckAt: this.deps.clock.now() + this.deps.lifecycle().pollIntervalMs }
        : {}),
      ...(clear.length > 0 ? { clear } : {}),
    };
    return this.deps.engine.update(op, patch, fence);
  }

  /**
   * Hands the all-rejected verdict to the engine: an unfenced pass (`tryOnce`) tries the
   * lease once, a fenced one waits `acquireTimeoutMs`, and either wait is bounded by the
   * pass `signal` (the caller's abort and, in `waitFor`, its deadline). A fenced pass's
   * terminal write carries its claim `fence`, so a worker whose claim was taken over writes
   * nothing. An unresolvable target leaves the Operation non-terminal.
   */
  private async failRejected(
    op: OperationRecord,
    signal: AbortSignal | undefined,
    fence: Fence | undefined,
  ): Promise<OperationRecord> {
    let target: OperationTarget | undefined;
    let failure: unknown;
    try {
      target = await this.deps.resolveTarget(op);
    } catch (error) {
      failure = error;
    }
    if (!target) {
      this.deps.log.warn('cannot resolve the target to fail a rejected operation', {
        operationId: op.id,
        code: errorCode(failure),
      });
      return op;
    }
    // Every unfenced pass (`getTransactionStatus`, `watch`, `waitFor`), signalled or not,
    // tries the lease once: a busy lease leaves the Operation for a later pass. Only a
    // fenced worker pass waits `acquireTimeoutMs`.
    return this.deps.engine.failRejected(target, op, {
      signal,
      ...(fence ? { fence } : { acquireTimeoutMs: 0 }),
    });
  }

  private bestStatus(
    record: OperationRecord,
    observations: ReadonlyMap<string, AttemptObservation>,
  ): TxStatus {
    const all = record.attempts
      .map((a) => observations.get(a.id))
      .filter((o): o is AttemptObservation => o !== undefined);
    const chosen =
      all.find(
        (o) => o.state === 'final' || (o.state === 'failed' && o.evidence === 'proven'),
      ) ??
      all
        .filter((o) => o.state === 'included' || o.state === 'failed')
        .sort((a, b) => b.confirmations - a.confirmations)[0] ??
      (record.activeAttemptId ? observations.get(record.activeAttemptId) : undefined);
    return chosen ? statusOf(chosen) : UNKNOWN;
  }

  private async rawStatus(target: ReadTarget, id: string): Promise<TxStatus> {
    const { reader } = target.pooled.driver;
    const [observation, head, finalized] = await Promise.all([
      reader.observe({ id, idKind: 'tx-hash', canonical: true }, undefined, undefined),
      reader.getBlockHeight(),
      reader.getFinalizedHeight(),
    ]);
    return statusFromObservation(observation, head, finalized);
  }

  private assertSameNetwork(target: ReadTarget, record: OperationRecord): void {
    const { chain, network } = target.selection;
    if (record.context.chain !== chain.id || record.context.network !== network.id) {
      throw new ValidationError(
        'INVALID_INTENT',
        `operation '${record.id}' belongs to ${record.context.chain}:${record.context.network}, not ${chain.id}:${network.id}`,
      );
    }
  }

  private defaultError(record: OperationRecord): SerializedError {
    const code = record.state === 'expired' ? 'TX_EXPIRED' : 'TX_REJECTED';
    return new ChainError(code, `operation ended in state '${record.state}'`).toJSON();
  }

  #reorged(op: OperationRecord, attempt: AttemptRecord, previousBlockHash: string): void {
    this.deps.events.emit('tx.reorged', {
      namespace: this.deps.namespace,
      operationId: op.id,
      attemptId: attempt.id,
      previousBlockHash,
    });
  }

  /**
   * Resends the stored raw bytes of a dropped active Attempt, at most once per
   * `rebroadcastIntervalMs`. The answer decides nothing (R25): `dropped` is never terminal,
   * and a refusal or rejection of bytes a node once held says nothing about them. An
   * acceptance is remembered (`firstSeenAt`) like the engine's broadcast path does.
   */
  async #rebroadcastDropped(
    target: ReadTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    observation: AttemptObservation,
    now: number,
  ): Promise<void> {
    if (
      now - (observation.lastBroadcastAt ?? 0) <
      this.deps.lifecycle().rebroadcastIntervalMs
    )
      return;
    let accepted = false;
    try {
      const result = await target.pooled.driver.broadcaster.broadcast({
        raw: attempt.raw,
        ref: attempt.ref,
      });
      accepted = result.kind === 'accepted' || result.kind === 'already-known';
    } catch (error) {
      // The code only: an error message may carry detail that logs must not.
      this.deps.log.debug('rebroadcast of a dropped attempt failed', {
        operationId: op.id,
        code: errorCode(error),
      });
    }
    await writeObservation(this.observationDeps, attempt, op.id, (stored) => ({
      lastBroadcastAt: now,
      ...(accepted ? { firstSeenAt: stored?.firstSeenAt ?? now } : {}),
    }));
  }
}

/**
 * An unmanaged transaction has no proofs to wait for: its observed finality is the answer,
 * whether it succeeded or reverted (`waitFor` rejects a reverted one with TX_REVERTED).
 */
function unmanagedFinal({ status, record }: Snapshot): boolean {
  return !record && status.finality === 'final';
}

function depth(head: bigint, height: bigint): number {
  const d = head - height + 1n;
  return d > 0n ? Number(d) : 0;
}
