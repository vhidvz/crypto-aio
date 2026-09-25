import { ConfigError, isCryptoAioError } from '../errors/error';
import {
  NON_TERMINAL_STATES,
  isTerminal,
  type Fence,
  type OperationClaim,
  type OperationPatch,
  type OperationRecord,
} from '../store/types';
import { randomId } from '../util/bytes';
import type { ReadTarget } from './engine';
import { PRE_SIGNING_STATES, errorCode } from './engine-rules';
import type { MonitorDeps, ReadResolver, TargetResolver } from './monitor';

/*
 * The monitor's background worker loop and startup recovery (M11: moved out of
 * `Monitor`, which delegates to `Workers`). They check Operations through the monitor
 * (`MonitorChecks`) and write only through the engine.
 */

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

/** What the worker loop and recovery use of the monitor's own checks. */
export interface MonitorChecks {
  checkPass(
    target: ReadTarget,
    op: OperationRecord,
    fence?: Fence,
    signal?: AbortSignal,
  ): Promise<{ readonly record: OperationRecord; readonly stale: boolean }>;
  check(
    target: ReadTarget,
    op: OperationRecord,
    fence?: Fence,
    signal?: AbortSignal,
  ): Promise<OperationRecord>;
  find(ref: string): Promise<OperationRecord | null>;
}

/** Worker passes and startup recovery for one monitor (see `Monitor`). */
export class Workers {
  /**
   * Per Operation, the expected nonces a `nonce.gap` was already emitted for; least
   * recently reported first, capped at `GAP_MEMORY` Operations (M2).
   */
  readonly #gaps = new Map<string, Set<string>>();

  constructor(
    private readonly deps: MonitorDeps,
    private readonly monitor: MonitorChecks,
  ) {}

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
    if (signal?.aborted) return 0;
    const claimed = await this.deps.stores.operations.claimDue(
      this.deps.namespace,
      options.workerId,
      this.deps.clock.now(),
      this.deps.lifecycle().claimLeaseMs,
      options.batch ?? DEFAULT_BATCH,
    );
    const reads = this.#passResolver(this.deps.resolveRead);
    const writes = this.#passResolver(this.deps.resolveTarget);
    for (const op of claimed) {
      const fence: Fence = { claimToken: (op.claim as OperationClaim).token };
      if (!signal?.aborted) await this.#process(reads, writes, op, fence, signal);
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
    reads: ReadResolver,
    writes: TargetResolver,
    op: OperationRecord,
    fence: Fence,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const started = this.deps.clock.now();
    let current: OperationRecord | undefined;
    try {
      const target = await this.#resolved(reads, op);
      const pass = await this.monitor.checkPass(target, op, fence, signal);
      current = pass.record;
      if (!pass.stale) await this.#detectNonceGap(target, current, writes);
    } catch (error) {
      // An abort mid-check is an expected shutdown, not a failure.
      this.deps.log[signal?.aborted ? 'debug' : 'warn'](
        signal?.aborted ? 'monitor check stopped' : 'monitor check failed',
        { operationId: op.id, code: errorCode(error) },
      );
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
    const reads = this.#passResolver(this.deps.resolveRead);
    const writes = this.#passResolver(this.deps.resolveTarget);
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
        const target = await this.#resolved(reads, op);
        let current = op;
        if (
          op.state === 'signed' ||
          (op.state === 'submitted' && op.ambiguous === true)
        ) {
          const writer = await this.#resolved(writes, op);
          try {
            current = await this.deps.engine.rebroadcast(writer, op.id, signal);
          } catch (error) {
            // A refusal or an unknown outcome is recorded on the Operation: check it next.
            if (
              !isCryptoAioError(error) ||
              (error.category !== 'chain' && error.ambiguous !== true)
            )
              throw error;
            current = (await this.monitor.find(op.id)) ?? op;
          }
          rebroadcast += 1;
        }
        await this.monitor.check(target, current, undefined, signal);
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
        const writer = await this.#resolved(writes, op);
        reconciled += (await this.deps.engine.reconcileNonces(writer, op, { signal }))
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

  /**
   * `resolve` for one pass: each execution context's target is rebuilt at most once, and
   * only when first asked for (R32: a wallet-bound one only by a write that needs it).
   */
  #passResolver<T>(
    resolve: (op: OperationRecord) => Promise<T | undefined>,
  ): (op: OperationRecord) => Promise<T | undefined> {
    const targets = new Map<string, Promise<T | undefined>>();
    return (op) => {
      let target = targets.get(op.context.configHash);
      if (!target) {
        target = resolve(op);
        targets.set(op.context.configHash, target);
      }
      return target;
    };
  }

  async #resolved<T>(
    resolve: (op: OperationRecord) => Promise<T | undefined>,
    op: OperationRecord,
  ): Promise<T> {
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
   * once (never a filler transaction): a leaked value goes back for the next transfer. R32:
   * only that write resolves the wallet-bound target (`writes`).
   */
  async #detectNonceGap(
    target: ReadTarget,
    op: OperationRecord,
    writes: TargetResolver,
  ): Promise<void> {
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
      const writer = await this.#resolved(writes, op);
      await this.deps.engine.reconcileNonces(writer, op, { acquireTimeoutMs: 0 });
    } catch (error) {
      const busy = isCryptoAioError(error, 'SEQUENCE_BUSY');
      this.deps.log[busy ? 'debug' : 'warn']('nonce reconciliation did not run', {
        operationId: op.id,
        code: errorCode(error),
      });
    }
  }
}
