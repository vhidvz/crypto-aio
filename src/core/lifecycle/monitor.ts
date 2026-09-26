import { statusFromObservation } from '../blockchain/mapping';
import type { ResolvedSelection } from '../config/types';
import type { ProofSource } from '../driver/types';
import {
  ChainError,
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
  isTerminal,
  type AttemptObservation,
  type AttemptRecord,
  type ClearableField,
  type Fence,
  type OperationPatch,
  type OperationRecord,
  type Stores,
} from '../store/types';
import { isStaleView } from '../transport/stale-view';
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
import { Workers, type RecoveryReport, type WorkerOptions } from './workers';

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

export type { RecoveryReport, WorkerOptions } from './workers';

/**
 * Rebuilds the wallet-bound target of a stored Operation (from its `context`); `undefined`
 * (or a rejection) when it cannot be resolved any more, e.g. its wallet config is gone.
 */
export type TargetResolver = (
  op: OperationRecord,
) => Promise<OperationTarget | undefined>;

/** R32: rebuilds the signer-free read target of a stored Operation; see `TargetResolver`. */
export type ReadResolver = (op: OperationRecord) => Promise<ReadTarget | undefined>;

export interface MonitorDeps {
  readonly engine: OperationEngine;
  readonly stores: Stores;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly namespace: string;
  readonly lifecycle: () => ResolvedLifecycle;
  /** R32: every check, worker pass and recovery read runs on this target (no wallet). */
  readonly resolveRead: ReadResolver;
  /**
   * R26.3/R32: resolved lazily, only for the writes that need a wallet-bound target: the
   * all-rejected verdict, nonce reconciliation and recovery's resend (none of them signs).
   */
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
  /** M11: the worker loop and recovery, over this monitor's checks. */
  readonly #workers: Workers;

  constructor(private readonly deps: MonitorDeps) {
    this.#workers = new Workers(deps, {
      checkPass: (target, op, fence, signal) =>
        this.#checkPass(target, op, fence, signal),
      check: (target, op, fence, signal) => this.check(target, op, fence, signal),
      find: (ref) => this.find(ref),
    });
  }

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
    if (isStaleView(pooled.transport, head)) return { record: op, stale: true };
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
    assertSameNetwork(target.selection, record);
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

  /** One worker pass (see `Workers.runOnce`); resolves to how many Operations it claimed. */
  runOnce(options: {
    readonly workerId: string;
    readonly batch?: number;
    readonly signal?: AbortSignal;
  }): Promise<number> {
    return this.#workers.runOnce(options);
  }

  /** Runs worker passes until `signal` aborts (see `Workers.start`). */
  start(options: WorkerOptions = {}): Promise<void> {
    return this.#workers.start(options);
  }

  /** Startup recovery for this namespace; it never signs (see `Workers.recover`). */
  recover(options: { readonly signal?: AbortSignal } = {}): Promise<RecoveryReport> {
    return this.#workers.recover(options);
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
      // The transaction is in another block than recorded: its old block was orphaned, once
      // the quorum confirms it (R33); one endpoint's other block alone decides nothing.
      if (
        current?.blockHash !== undefined &&
        seen.blockHash !== undefined &&
        current.blockHash !== seen.blockHash
      ) {
        if (!(await this.orphaned(target, current))) return current;
        signal?.throwIfAborted();
        reorgedFrom = current.blockHash;
      }
      patch = {
        state: seen.success === false ? 'failed' : 'included',
        evidence: 'observed',
        confirmations: depth(head, seen.blockHeight),
        blockHeight: seen.blockHeight,
        blockHash: seen.blockHash,
        ...(seen.txHash !== undefined ? { txHash: seen.txHash } : {}),
        // P6-2: why an included transaction failed, as the driver's fixed text (R24); any
        // earlier reason (a refusal, an old failure) is cleared otherwise (M8).
        reason: seen.success === false ? seen.reason : undefined,
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: now,
      };
      if (seen.blockHeight <= finalized)
        patch = await this.proveFinal(target, op, attempt, patch, head, signal);
    } else {
      if (current?.blockHash !== undefined) {
        // Absence (or a mempool sighting) of an included transaction is not evidence of a
        // reorg by itself: a lagging or inconsistent endpoint shows the same. Only a
        // quorum-served different block at the recorded height proves it; otherwise decide
        // nothing.
        if (!(await this.orphaned(target, current))) return current;
        signal?.throwIfAborted();
        reorgedFrom = current.blockHash;
      }
      // M8: out of a block, an earlier failure's reason no longer applies (a refusal keeps
      // its own, below).
      const cleared: ObservationPatch = {
        blockHash: undefined,
        blockHeight: undefined,
        confirmations: 0,
        reason: undefined,
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
      await this.#rebroadcastDropped(target, op, attempt, saved, now, signal);
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
      reason: failureReason(proof),
    };
  }

  /**
   * Whether the block recorded for `observation` is no longer the one at its height. R33:
   * only the quorum-served hash decides; a disagreement or other retryable failure, or no
   * block at that height yet, decides nothing (`false`).
   */
  private async orphaned(
    target: ReadTarget,
    observation: AttemptObservation,
  ): Promise<boolean> {
    const { blockHeight, blockHash } = observation;
    if (blockHeight === undefined || blockHash === undefined) return false;
    let canonical: string | null;
    try {
      canonical = await target.pooled.driver.proofs.blockHash(blockHeight, 'latest');
    } catch (error) {
      if (!isCryptoAioError(error) || !error.retryable) throw error;
      return false;
    }
    return canonical !== null && canonical !== blockHash;
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
          reason: failureReason(proof),
        };
      }
      return { state: deadSlot ? 'replaced' : 'expired', evidence: 'proven' };
    }
    if (slotted && (await read(() => proofs.slotConsumed(ordering, from, 'latest')))) {
      return { state: 'replaced', evidence: 'observed' };
    }
    if (current?.state === 'refused') {
      return { state: 'refused', evidence: 'observed', reason: current.reason };
    }
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
      // As in `whenAbsent`, a proven `replaced` carries no reason: a refusal's no longer
      // applies (M8, P25-R15).
      const linked = (o: AttemptObservation | null | undefined) =>
        isSettled(o) && !(o?.state === 'replaced' && o.replacedBy === undefined);
      for (const attempt of op.attempts) {
        if (attempt.id === winner.id || linked(observations.get(attempt.id))) continue;
        await writeObservation(this.observationDeps, attempt, op.id, (stored) =>
          linked(stored)
            ? undefined
            : {
                state: 'replaced',
                evidence: 'proven',
                replacedBy: winner.ref.id,
                reason: undefined,
              },
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
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      now - (observation.lastBroadcastAt ?? 0) <
      this.deps.lifecycle().rebroadcastIntervalMs
    )
      return;
    let accepted = false;
    try {
      const result = await target.pooled.driver.broadcaster.broadcast(
        { raw: attempt.raw, ref: attempt.ref },
        signal ? { signal } : {},
      );
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

/** Refuses a stored Operation of another chain or network than `selection` (INVALID_INTENT). */
export function assertSameNetwork(
  selection: Pick<ResolvedSelection, 'chain' | 'network'>,
  record: OperationRecord,
): void {
  const { chain, network } = selection;
  if (record.context.chain !== chain.id || record.context.network !== network.id) {
    throw new ValidationError(
      'INVALID_INTENT',
      `operation '${record.id}' belongs to ${record.context.chain}:${record.context.network}, not ${chain.id}:${network.id}`,
    );
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

/** P6-2: a proven failure's fixed reason (R24); a success clears any earlier reason (M8). */
function failureReason(proof: {
  readonly success: boolean;
  readonly reason?: string;
}): string | undefined {
  return proof.success ? undefined : proof.reason;
}
