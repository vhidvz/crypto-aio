import type { LifecycleOptions } from '../config/types';
import {
  ChainError,
  ConfigError,
  createError,
  isCryptoAioError,
  type CryptoAioError,
  type ErrorCode,
  type SerializedError,
} from '../errors/error';
import type { FeeOverride, FeeSpeed } from '../model/fee';
import type { OrderingData, OrderingKind } from '../model/ordering';
import type { TxState, UnsignedTx } from '../model/transaction';
import { sanitizeError } from '../secret/redact';
import type {
  AttemptObservation,
  AttemptRecord,
  OperationRecord,
  OperationState,
  SequenceState,
} from '../store/types';
import { canonicalJson } from '../util/json';
import type { ObservationPatch } from './observations';

/*
 * The engine's pure rules (M11): lifecycle defaults, error serialization, and the state
 * sets and predicates `OperationEngine` decides with. No I/O and no engine state.
 */

export type ResolvedLifecycle = Required<LifecycleOptions>;

export const LIFECYCLE_DEFAULTS: ResolvedLifecycle = {
  pollIntervalMs: 5_000,
  droppedGracePeriodMs: 120_000,
  rebroadcastIntervalMs: 60_000,
  leaseMs: 30_000,
  claimLeaseMs: 60_000,
  waitTimeoutMs: 600_000,
  requireIdempotencyKey: false,
  broadcastFanout: 1,
  signTimeoutMs: 120_000,
};

export function withLifecycleDefaults(options: LifecycleOptions): ResolvedLifecycle {
  const out: Record<string, unknown> = { ...LIFECYCLE_DEFAULTS };
  for (const [key, value] of Object.entries(options))
    if (value !== undefined) out[key] = value;
  const { signTimeoutMs } = out as ResolvedLifecycle;
  if (
    typeof signTimeoutMs !== 'number' ||
    !Number.isFinite(signTimeoutMs) ||
    signTimeoutMs <= 0
  ) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'lifecycle.signTimeoutMs must be a finite number greater than 0',
    );
  }
  return out as ResolvedLifecycle;
}

export const PRE_SIGNING_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'created',
  'prepared',
  'awaiting-signature',
]);

export const LEASED_ORDERINGS = new Set(['nonce', 'seqno', 'inputs']);
export const DEFINITIVE_CATEGORIES = new Set([
  'validation',
  'chain',
  'unsupported',
  'config',
  'signing',
]);

/**
 * M8: a crypto-aio error as it is; anything else under `fallback`, the most specific
 * existing code for the caller's context (there is no generic code), with a sanitized message.
 */
export function serializeError(error: unknown, fallback: ErrorCode): SerializedError {
  return (
    isCryptoAioError(error) ? error : createError(fallback, sanitizeError(error).message)
  ).toJSON();
}

export function rehydrateError(serialized: SerializedError, operationId: string): Error {
  return createError(serialized.code, serialized.message, {
    context: { ...serialized.context, operationId },
    ...(serialized.details ? { details: serialized.details } : {}),
    retryable: serialized.retryable,
    ambiguous: serialized.ambiguous,
  });
}

/**
 * The error's crypto-aio code, or `'UNKNOWN'`. Logs carry this, never the error itself:
 * messages may hold addresses, amounts or store detail.
 */
export function errorCode(error: unknown): string {
  return isCryptoAioError(error) ? error.code : 'UNKNOWN';
}

export function isDefinitive(error: unknown): error is CryptoAioError {
  return (
    isCryptoAioError(error) &&
    !error.retryable &&
    DEFINITIVE_CATEGORIES.has(error.category)
  );
}

/**
 * Observation states backed by chain evidence: the Attempt was mined, or its slot or expiry
 * was consumed. No broadcast answer ever overwrites them (R24, R25); `replacedBy` is kept.
 */
export const CHAIN_EVIDENCE_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'included',
  'final',
  'failed',
  'replaced',
  'expired',
]);

/**
 * R25: a node once accepted these bytes, or they may be live. `firstSeenAt` is the durable
 * marker: set when a node accepted them or the monitor saw them held, and kept by a refusal
 * that found them possibly live (I2). A `pending`, `mempool` or `dropped` observation also
 * counts: one left by an accepted or ambiguous send, and (M5) the `pending` the monitor
 * writes for a signed Attempt that was never broadcast, which errs in the safe direction
 * (a genuine rejection then stalls it and keeps its nonce instead of failing it). A later
 * rejection says nothing about bytes that may still sit in a mempool, so it is only a
 * refusal: never terminal, the nonce is kept.
 */
export function mayBeLive(observation: AttemptObservation | null): boolean {
  return (
    observation !== null &&
    (observation.firstSeenAt !== undefined ||
      observation.state === 'pending' ||
      observation.state === 'mempool' ||
      observation.state === 'dropped')
  );
}

/**
 * A send that may have delivered the bytes (accepted, already known or ambiguous): a
 * missing, `refused` or `dropped` observation becomes `pending`, and a refusal's reason no
 * longer applies (M8, P25-R14/R15). Stronger evidence (chain or proven states) is left
 * alone (R24). The one rule for every such send, so they cannot drift apart.
 */
export function pendingAfterSend(current: AttemptObservation | null): ObservationPatch {
  return current === null || current.state === 'refused' || current.state === 'dropped'
    ? { state: 'pending', reason: undefined }
    : {};
}

/** Every nonce a live Operation holds: its reservation, unsigned payload and Attempts. */
export function heldNonces(op: OperationRecord): bigint[] {
  const orderings = [
    op.reservation,
    op.unsigned?.ordering,
    ...op.attempts.map((a) => a.ordering),
  ];
  return orderings.flatMap((o) => (o?.kind === 'nonce' ? [o.nonce] : []));
}

/** Failures proven on chain at finality: their nonce was consumed. */
export const CONSUMED_FAILURES: ReadonlySet<string> = new Set([
  'TX_REVERTED',
  'TX_REPLACED',
]);

/** Whether some value in [from, next) is neither released nor held. */
export function hasReclaimable(
  state: SequenceState | null,
  from: bigint,
  held: readonly bigint[],
): boolean {
  if (!state) return false;
  const taken = new Set([...state.released, ...held]);
  for (let value = from; value < state.next; value++) if (!taken.has(value)) return true;
  return false;
}

/** `signed`, or `submitted` with an unknown broadcast outcome: its stored bytes are (re)sent. */
export function awaitsBroadcast(op: OperationRecord): boolean {
  return op.state === 'signed' || (op.state === 'submitted' && op.ambiguous === true);
}

/** The node's own answer (refused, rejected): not ambiguous, so the bytes were not taken. */
export function isRefusal(error: unknown): boolean {
  return isCryptoAioError(error) && error.category === 'chain' && !error.ambiguous;
}

/**
 * R30: a replacement records the fee spec it was asked for (plain data, R11) in its fee
 * details, so a repeat of the same request is recognised instead of signed again.
 */
export function withRequestedFee(
  unsigned: UnsignedTx,
  fee: FeeSpeed | FeeOverride,
): UnsignedTx {
  return {
    ...unsigned,
    fee: { ...unsigned.fee, details: { ...unsigned.fee.details, requestedFee: fee } },
  };
}

/** An Attempt's total fee, summed over its charges. */
export function feeOf(attempt: AttemptRecord): bigint {
  return attempt.fee.charges.reduce((sum, charge) => sum + charge.amount, 0n);
}

/**
 * N3/R2-1: the cancel a new cancel is bumped from: among the earlier cancels that superseded
 * the active Attempt `previous` (refused ones gave it the active role back), the one paying
 * the most, so repeated bumps climb; otherwise `previous` itself, so a cancel never starts
 * below a newer, higher replacement. Fees are compared only between cancels.
 */
export function cancelBase(op: OperationRecord, previous: AttemptRecord): AttemptRecord {
  let best: AttemptRecord | undefined;
  for (const attempt of op.attempts) {
    if (attempt.purpose !== 'cancel' || attempt.supersedes !== previous.id) continue;
    if (!best || feeOf(attempt) > feeOf(best)) best = attempt;
  }
  return best ?? previous;
}

/** R30: the same `FeeSpeed` name, or a canonically equal `FeeOverride`. */
export function sameFeeSpec(
  attempt: AttemptRecord,
  fee: FeeSpeed | FeeOverride | undefined,
): boolean {
  const recorded = attempt.fee.details.requestedFee;
  if (recorded === undefined || fee === undefined) return false;
  try {
    return canonicalJson(recorded) === canonicalJson(fee);
  } catch {
    return false;
  }
}

/**
 * What `restoreAfterRefusal` puts back: the Operation as the refused Attempt found it.
 * Without `state`, only the active Attempt is swapped (state and error are kept).
 */
export interface RestorePoint {
  readonly state?: OperationState;
  readonly activeAttemptId: string;
  readonly error?: SerializedError;
  readonly ambiguous?: boolean;
}

/** R30.2: a node's refusal or rejection of these bytes; both are handled alike. */
export const NODE_REFUSED_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'refused',
  'rejected',
]);

/** N2: observations under which a superseded Attempt may still be live on the network. */
export const LIVE_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'pending',
  'mempool',
  'included',
]);

/** Spec §8.6: the states in which a replacement or cancel may supersede the active Attempt. */
export const CONFLICTABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'submitted',
  'stalled',
]);
/** The only state `rebuild` reopens. */
export const REBUILDABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'expired',
]);
/** Where the stored bytes of a new Attempt whose broadcast never completed are resent. */
export const RESUMABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'signed',
  'submitted',
  'stalled',
]);

/**
 * M1: the built transaction must use exactly the slot the engine reserved: the ordering
 * kind of the driver, the allocated nonce or seqno, and no input held by another live
 * Operation. Anything else would persist a reservation nobody allocated.
 */
export function assertBuiltOrdering(
  operationId: string,
  kind: OrderingKind,
  allocated: OrderingData | undefined,
  excluded: readonly string[] | undefined,
  built: OrderingData,
): void {
  // No existing code names an input conflict without implying a nonce, so NONCE_CONFLICT
  // (the ordering-slot conflict code) is kept and the message says what actually clashed.
  if (built.kind === kind && built.kind === 'inputs') {
    if (built.inputs.some((input) => excluded?.includes(input))) {
      throw new ChainError(
        'NONCE_CONFLICT',
        'input reservation conflict: the built transaction spends an input held by another operation',
        { context: { operationId } },
      );
    }
    return;
  }
  const matches =
    built.kind === kind &&
    (built.kind === 'nonce'
      ? allocated?.kind === 'nonce' && built.nonce === allocated.nonce
      : built.kind === 'seqno'
        ? allocated?.kind === 'seqno' && built.seqno === allocated.seqno
        : true);
  if (!matches) {
    throw new ChainError(
      'NONCE_CONFLICT',
      'the built transaction does not use the ordering slot reserved for it',
      { context: { operationId } },
    );
  }
}
