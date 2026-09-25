import type { AssetService } from '../assets/service';
import type { LifecycleOptions, ResolvedSelection } from '../config/types';
import type { PooledDriver } from '../container/pool';
import type { BroadcastResult, BuildContext, SequenceSource } from '../driver/types';
import {
  ChainError,
  ConfigError,
  ProviderError,
  SigningError,
  StateError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  createError,
  isCryptoAioError,
  withContext,
  type CryptoAioError,
  type SerializedError,
} from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import {
  intentHash,
  toStoredIntent,
  type StoredIntent,
  type TransferIntent,
} from '../model/intent';
import type { FeeOverride, FeeSpeed } from '../model/fee';
import {
  mutuallyExclusive,
  type OrderingData,
  type OrderingKind,
} from '../model/ordering';
import type { TxState, UnsignedTx } from '../model/transaction';
import { reservedInputs, seqnoHolder } from '../ordering/reservations';
import {
  sequenceKey,
  type LeaseHandle,
  type SequenceCoordinator,
} from '../ordering/sequence';
import { sanitizeError } from '../secret/redact';
import type { OrchestratedResult, SigningOrchestrator } from '../signing/orchestrator';
import type {
  SignatureBundle,
  SignerTicket,
  SigningContext,
  SigningPurpose,
  SigningRequest,
} from '../signing/types';
import type { ResolvedWallet } from '../signing/wallet';
import {
  NON_TERMINAL_STATES,
  isTerminal,
  type AttemptObservation,
  type AttemptPurpose,
  type AttemptRecord,
  type ClearableField,
  type ExecutionContext,
  type Fence,
  type OperationFilter,
  type OperationPatch,
  type OperationRecord,
  type OperationState,
  type SequenceState,
  type Stores,
} from '../store/types';
import { randomId } from '../util/bytes';
import { abortReason, type Clock } from '../util/clock';
import { canonicalJson, sha256Hex } from '../util/json';
import { normalizeIntent, validateFee } from './intent';
import {
  writeObservation,
  type ObservationDeps,
  type ObservationPatch,
} from './observations';

/** What read-only lifecycle work (monitoring, waiting) needs: no wallet required. */
export interface ReadTarget {
  readonly selection: ResolvedSelection;
  readonly pooled: PooledDriver;
}

export interface OperationTarget extends ReadTarget {
  readonly wallet: ResolvedWallet;
  readonly assets: AssetService;
}

export interface TransferOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

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

export interface EngineDeps {
  readonly namespace: string;
  readonly stores: Stores;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly orchestrator: SigningOrchestrator;
  readonly sequences: SequenceCoordinator;
  readonly lifecycle: () => ResolvedLifecycle;
}

export const PRE_SIGNING_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'created',
  'prepared',
  'awaiting-signature',
]);

const LEASED_ORDERINGS = new Set(['nonce', 'seqno', 'inputs']);
const DEFINITIVE_CATEGORIES = new Set([
  'validation',
  'chain',
  'unsupported',
  'config',
  'signing',
]);

export function serializeError(error: unknown): SerializedError {
  return (
    isCryptoAioError(error)
      ? error
      : createError('SIGNING_FAILED', sanitizeError(error).message)
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

function isDefinitive(error: unknown): boolean {
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
const CHAIN_EVIDENCE_STATES: ReadonlySet<TxState> = new Set<TxState>([
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
function mayBeLive(observation: AttemptObservation | null): boolean {
  return (
    observation !== null &&
    (observation.firstSeenAt !== undefined ||
      observation.state === 'pending' ||
      observation.state === 'mempool' ||
      observation.state === 'dropped')
  );
}

/** Every nonce a live Operation holds: its reservation, unsigned payload and Attempts. */
function heldNonces(op: OperationRecord): bigint[] {
  const orderings = [
    op.reservation,
    op.unsigned?.ordering,
    ...op.attempts.map((a) => a.ordering),
  ];
  return orderings.flatMap((o) => (o?.kind === 'nonce' ? [o.nonce] : []));
}

/** Failures proven on chain at finality: their nonce was consumed. */
const CONSUMED_FAILURES: ReadonlySet<string> = new Set(['TX_REVERTED', 'TX_REPLACED']);

/** Whether some value in [from, next) is neither released nor held. */
function hasReclaimable(
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
function awaitsBroadcast(op: OperationRecord): boolean {
  return op.state === 'signed' || (op.state === 'submitted' && op.ambiguous === true);
}

/** The node's own answer (refused, rejected): not ambiguous, so the bytes were not taken. */
function isRefusal(error: unknown): boolean {
  return isCryptoAioError(error) && error.category === 'chain' && !error.ambiguous;
}

/**
 * R30: a replacement records the fee spec it was asked for (plain data, R11) in its fee
 * details, so a repeat of the same request is recognised instead of signed again.
 */
function withRequestedFee(unsigned: UnsignedTx, fee: FeeSpeed | FeeOverride): UnsignedTx {
  return {
    ...unsigned,
    fee: { ...unsigned.fee, details: { ...unsigned.fee.details, requestedFee: fee } },
  };
}

/** An Attempt's total fee, summed over its charges. */
function feeOf(attempt: AttemptRecord): bigint {
  return attempt.fee.charges.reduce((sum, charge) => sum + charge.amount, 0n);
}

/**
 * N3/R2-1: the cancel a new cancel is bumped from: among the earlier cancels that superseded
 * the active Attempt `previous` (refused ones gave it the active role back), the one paying
 * the most, so repeated bumps climb; otherwise `previous` itself, so a cancel never starts
 * below a newer, higher replacement. Fees are compared only between cancels.
 */
function cancelBase(op: OperationRecord, previous: AttemptRecord): AttemptRecord {
  let best: AttemptRecord | undefined;
  for (const attempt of op.attempts) {
    if (attempt.purpose !== 'cancel' || attempt.supersedes !== previous.id) continue;
    if (!best || feeOf(attempt) > feeOf(best)) best = attempt;
  }
  return best ?? previous;
}

/** R30: the same `FeeSpeed` name, or a canonically equal `FeeOverride`. */
function sameFeeSpec(
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
interface RestorePoint {
  readonly state?: OperationState;
  readonly activeAttemptId: string;
  readonly error?: SerializedError;
  readonly ambiguous?: boolean;
}

/** R30.2: a node's refusal or rejection of these bytes; both are handled alike. */
const NODE_REFUSED_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'refused',
  'rejected',
]);

/** N2: observations under which a superseded Attempt may still be live on the network. */
const LIVE_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'pending',
  'mempool',
  'included',
]);

/** Spec §8.6: the states in which a replacement or cancel may supersede the active Attempt. */
const CONFLICTABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'submitted',
  'stalled',
]);
/** The only state `rebuild` reopens. */
const REBUILDABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'expired',
]);
/** Where the stored bytes of a new Attempt whose broadcast never completed are resent. */
const RESUMABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'signed',
  'submitted',
  'stalled',
]);

/**
 * M1: the built transaction must use exactly the slot the engine reserved: the ordering
 * kind of the driver, the allocated nonce or seqno, and no input held by another live
 * Operation. Anything else would persist a reservation nobody allocated.
 */
function assertBuiltOrdering(
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

export class OperationEngine {
  constructor(protected readonly deps: EngineDeps) {}

  get namespace(): string {
    return this.deps.namespace;
  }

  /** Builds and persists the unsigned transaction; runs the policy hook. Idempotent per key. */
  async prepare(
    target: OperationTarget,
    intent: TransferIntent,
    options: TransferOptions = {},
  ): Promise<OperationRecord> {
    const { record, stored } = await this.open(target, intent, options);
    let current = record;
    if (current.state === 'created' || current.state === 'prepared') {
      // R23: the policy check and its failure transition run under the address lease too,
      // and a repeat of a `prepared` Operation (e.g. after a lost ack) is authorized again.
      current = await this.withAddressLease(
        target,
        record,
        async (lease) => {
          let fresh = await this.require(record.id);
          if (fresh.state === 'created') {
            fresh = await this.prepareStage(target, fresh, stored, lease, options.signal);
          }
          if (fresh.state === 'prepared') {
            await this.authorizeOrFail(target, fresh, lease, options.signal);
          }
          return fresh;
        },
        options.signal,
      );
    }
    return this.settle(current);
  }

  /**
   * Idempotent transfer: prepare → sign → persist the Attempt (write-ahead) → broadcast.
   * A repeat resumes where the Operation stopped and never signs an Attempt twice.
   */
  async transfer(
    target: OperationTarget,
    intent: TransferIntent,
    options: TransferOptions = {},
  ): Promise<OperationRecord> {
    if (target.wallet.watchOnly) {
      throw new SigningError(
        'SIGNER_UNAVAILABLE',
        `wallet '${target.wallet.name}' is watch-only; use prepareTransfer and submitSignatures`,
      );
    }
    const { record, stored } = await this.open(target, intent, options);
    return this.drive(target, record, stored, options.signal);
  }

  /**
   * Adds externally produced signatures (cold, offline, MPC); completes and broadcasts once
   * every request is signed. Under the address lease (R23), and the `beforeSign` policy is
   * asked again first (defence in depth): a veto fails the Operation, releases its nonce and
   * cancels its signer tickets, as a veto before signing does.
   */
  async submitSignatures(
    target: OperationTarget,
    operationId: string,
    signatures: readonly SignatureBundle[],
  ): Promise<OperationRecord> {
    let vetoed: readonly SignerTicket[] = [];
    try {
      const listed = await this.require(operationId);
      const done = await this.withOperationLease(target, listed, async (lease) => {
        const op = await this.require(operationId);
        this.assertOwnedBy(target, op);
        if (op.state !== 'prepared' && op.state !== 'awaiting-signature') {
          throw new StateError(
            'INVALID_TRANSITION',
            `cannot submit signatures in state '${op.state}'`,
            { context: { operationId } },
          );
        }
        const unsigned = op.unsigned as UnsignedTx;
        const requests = unsigned.signingRequests;
        const merged = this.deps.orchestrator.accept(
          requests,
          signatures,
          this.usablePartials(op, requests),
        );
        const ctx = this.signingContext(target, op, unsigned, 'original');
        try {
          await this.signingDeadline(op, lease, undefined, () =>
            this.deps.orchestrator.authorize(ctx),
          );
        } catch (error) {
          if (isCryptoAioError(error, 'POLICY_REJECTED')) {
            await this.failAfterPrepare(target, op, error, lease);
            vetoed = op.signerTickets ?? [];
          }
          throw error;
        }
        if (merged.length < requests.length) {
          await lease?.renew();
          return this.update(op, {
            state: 'awaiting-signature',
            partialSignatures: merged,
          });
        }
        const signed = await this.appendSigned(
          target,
          op,
          unsigned,
          merged,
          'original',
          undefined,
          lease,
        );
        return awaitsBroadcast(signed)
          ? this.broadcastActive(target, signed, undefined, lease)
          : signed;
      });
      return this.settle(done);
    } finally {
      // Only after a veto's terminal write landed, and after the lease is dropped.
      await this.cancelTickets(target, operationId, vetoed);
    }
  }

  /**
   * Resends the SAME stored raw bytes of the active Attempt (never builds or signs), under
   * the address lease (R23). N1: a refused replacement or cancel gives the active role back
   * to the Attempt it superseded (`resendActive`).
   */
  async rebroadcast(
    target: OperationTarget,
    operationId: string,
  ): Promise<OperationRecord> {
    const listed = await this.require(operationId);
    return this.withAddressLease(target, listed, async (lease) => {
      const op = await this.require(operationId);
      this.assertOwnedBy(target, op);
      if (
        isTerminal(op.state) ||
        PRE_SIGNING_STATES.has(op.state) ||
        !op.activeAttemptId
      ) {
        throw new StateError(
          'INVALID_TRANSITION',
          `nothing to rebroadcast in state '${op.state}'`,
          { context: { operationId } },
        );
      }
      return this.resendActive(target, op, undefined, lease);
    });
  }

  /**
   * Only before any signed bytes exist. Under the address lease (R23): re-reads the
   * Operation, renews the lease (a lost lease fails before any write), marks it
   * `abandoned` and releases its reservation. Pending signer tickets are cancelled after
   * the lease is dropped, even when the release failed.
   */
  async abandon(target: OperationTarget, operationId: string): Promise<OperationRecord> {
    let tickets: readonly SignerTicket[] = [];
    try {
      const listed = await this.require(operationId);
      return await this.withAddressLease(target, listed, async (lease) => {
        const op = await this.require(operationId);
        this.assertOwnedBy(target, op);
        if (!PRE_SIGNING_STATES.has(op.state)) {
          throw new StateError(
            'INVALID_TRANSITION',
            `cannot abandon an operation in state '${op.state}'`,
            { context: { operationId } },
          );
        }
        await lease?.renew();
        const next = await this.update(op, {
          state: 'abandoned',
          clear: ['partialSignatures', 'signerTickets'],
        });
        tickets = op.signerTickets ?? [];
        await this.releaseReservation(op, lease);
        return next;
      });
    } finally {
      await this.cancelTickets(target, operationId, tickets);
    }
  }

  /** R22: best effort, through the signer that issued each ticket; failures log codes only. */
  protected async cancelTickets(
    target: OperationTarget,
    operationId: string,
    tickets: readonly SignerTicket[],
  ): Promise<void> {
    for (const { signerId, ticket } of tickets) {
      const issuer = target.wallet.signerById(signerId);
      if (!issuer) {
        this.deps.log.warn('signer cancelRequest failed', {
          operationId,
          signerId,
          code: 'SIGNER_UNAVAILABLE',
        });
        continue;
      }
      try {
        await issuer.signer.cancelRequest?.(ticket);
      } catch (error) {
        this.deps.log.warn('signer cancelRequest failed', {
          operationId,
          signerId,
          code: errorCode(error),
        });
      }
    }
  }

  /**
   * Spec §8.6: a new Attempt paying a higher fee for the same slot (same nonce or seqno,
   * or conflicting inputs). Needs the `replace-fee` capability, the driver's
   * ReplacementPolicy and a synchronous signer; `submitted` or `stalled` only. See
   * `createConflicting`.
   *
   * R30: idempotent per fee spec. While the active Attempt is a replacement made for the
   * same spec (the same `FeeSpeed` name, or a canonically equal `FeeOverride`), a repeat
   * signs nothing and returns it, resending its stored bytes when their broadcast was never
   * recorded or was ambiguous. N1: a replacement for the same spec that was refused (the
   * superseded Attempt active again) is resent, never signed again; a refusal is thrown,
   * never a success. To bump again, pass another spec (e.g. a higher override).
   *
   * M-a: while the active replacement is persisted but unsent (`signed`), another fee spec
   * is refused with INVALID_TRANSITION; repeat the same spec (it is resent) or call
   * `rebroadcast` first.
   */
  async replace(
    target: OperationTarget,
    operationId: string,
    fee: FeeSpeed | FeeOverride,
  ): Promise<OperationRecord> {
    const policy = target.pooled.driver.replacement;
    const build = policy?.replace ? policy.buildReplacement?.bind(policy) : undefined;
    if (!build || !target.selection.capabilities.has('replace-fee')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${target.selection.chain.id} does not support fee replacement`,
      );
    }
    if (fee === undefined)
      throw new ValidationError('INVALID_INTENT', 'a replacement needs a fee');
    validateFee(fee);
    return this.createConflicting(
      target,
      operationId,
      'replacement',
      fee,
      async (previous, ctx) => withRequestedFee(await build(previous, fee, ctx), fee),
    );
  }

  /**
   * "Cancel" is a conflicting transaction for the same slot (e.g. a self-transfer), not a
   * protocol primitive: the outcome is `cancelled` only when the cancel Attempt reaches
   * proven finality, and the original may still win. Capability `cancel`; `submitted` or
   * `stalled` only. It pays the driver's minimum bump over the highest-fee earlier cancel
   * (or over the active Attempt when there is none), or `fee` when given (refused below
   * that bump). See `createConflicting`.
   *
   * R30.1: a repeat while a cancel is the active Attempt resends its stored bytes when their
   * broadcast was never recorded or was ambiguous, and returns it unchanged while a node
   * holds it (`pending`, `mempool`) or once it is on chain; concurrent and retried cancels
   * are idempotent. Only a cancel recorded `refused` or `dropped` is bumped by a repeat (N3:
   * each bump climbs one step from the highest-fee cancel), so a cancel that cannot land
   * never leaves the nonce stuck. When the node's floor is more than one bump away, pass
   * `fee`: an explicit fee always builds a new cancel while none is on chain.
   *
   * M-a: while the active replacement is persisted but unsent (`signed`), a cancel is refused
   * with INVALID_TRANSITION; repeat that replacement's fee spec (it is resent) or call
   * `rebroadcast` first.
   */
  async cancel(
    target: OperationTarget,
    operationId: string,
    fee?: FeeSpeed | FeeOverride,
  ): Promise<OperationRecord> {
    const policy = target.pooled.driver.replacement;
    const build = policy?.cancel ? policy.buildCancel?.bind(policy) : undefined;
    if (!build || !target.selection.capabilities.has('cancel')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${target.selection.chain.id} does not support cancellation`,
      );
    }
    if (fee !== undefined) validateFee(fee);
    return this.createConflicting(target, operationId, 'cancel', fee, (previous, ctx) =>
      build(previous, ctx, fee),
    );
  }

  /**
   * Expiry and seqno chains only: once every earlier Attempt is provably dead (re-proved
   * here from finalized state, `assertAttemptsDead`), an `expired` Operation gets a fresh
   * Attempt and is live again. It is the one explicit exception to "a terminal Operation
   * never moves" (see `appendSigned`). Under the Operation's lease (the op lock on expiry
   * chains, the address lease on seqno chains); signed once, persisted before its
   * broadcast, and a repeat resends a persisted rebuild instead of signing another. On a
   * seqno chain it takes the wallet's next seqno (SEQUENCE_BUSY while another live
   * Operation holds it), and the Operation's `reservation` is refreshed to the rebuilt
   * Attempt's ordering in the same write as the Attempt (M1). A refusal of the rebuilt
   * Attempt leaves the Operation `stalled`, never `expired` again: only the monitor's proof
   * can end it.
   */
  async rebuild(target: OperationTarget, operationId: string): Promise<OperationRecord> {
    const driver = target.pooled.driver;
    if (driver.ordering !== 'expiry' && driver.ordering !== 'seqno') {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${target.selection.chain.id} transactions do not expire; use replace or cancel`,
      );
    }
    const listed = await this.require(operationId);
    const done = await this.withOperationLease(target, listed, async (lease) => {
      const op = await this.require(operationId);
      this.assertOwnedBy(target, op);
      const resumed = await this.resumeNewAttempt(target, op, 'rebuild', lease);
      if (resumed) return resumed;
      if (!REBUILDABLE_STATES.has(op.state)) {
        throw new StateError(
          'INVALID_TRANSITION',
          `only expired operations can be rebuilt (state '${op.state}')`,
          { context: { operationId } },
        );
      }
      await this.assertAttemptsDead(target, op);
      let ordering: OrderingData | undefined;
      if (driver.ordering === 'seqno') {
        if (!driver.sequence) {
          throw new StateError(
            'INVALID_TRANSITION',
            `the ${op.context.chain} driver has seqno ordering but no sequence source`,
          );
        }
        ordering = await this.nextSeqno(driver.sequence, op);
      }
      const build: BuildContext = {
        from: op.intent.from,
        keys: target.wallet.keys,
        wallet: target.wallet.options,
        ...(ordering ? { ordering } : {}),
      };
      const fee = await driver.builder.estimateFee(op.intent, build);
      const unsigned = await driver.builder.build(op.intent, fee, build);
      assertBuiltOrdering(op.id, driver.ordering, ordering, undefined, unsigned.ordering);
      const { signed } = await this.signNewAttempt(
        target,
        op,
        unsigned,
        'rebuild',
        REBUILDABLE_STATES,
        lease,
      );
      return this.broadcastActive(target, signed, undefined, lease);
    });
    return this.settle(done);
  }

  get(operationId: string): Promise<OperationRecord | null> {
    return this.deps.stores.operations.get(this.deps.namespace, operationId);
  }

  async require(operationId: string): Promise<OperationRecord> {
    const record = await this.get(operationId);
    if (!record)
      throw new StateError('NOT_FOUND', `operation '${operationId}' not found`);
    return record;
  }

  // ---- shared building blocks ----------------------------------------------------------

  protected async open(
    target: OperationTarget,
    intent: TransferIntent,
    options: TransferOptions,
  ): Promise<{ record: OperationRecord; stored: StoredIntent }> {
    const key = options.idempotencyKey;
    if (key === undefined && this.deps.lifecycle().requireIdempotencyKey) {
      throw new ValidationError(
        'INVALID_INTENT',
        'an idempotencyKey is required (lifecycle.requireIdempotencyKey)',
      );
    }
    if (key !== undefined && (key.length === 0 || key.length > 200)) {
      throw new ValidationError(
        'INVALID_INTENT',
        'idempotencyKey must be 1-200 characters',
      );
    }
    const { selection } = target;
    const normalized = await normalizeIntent(
      { selection, driver: target.pooled.driver, assets: target.assets },
      intent,
      target.wallet.address,
    );
    const stored = toStoredIntent(normalized);
    const hash = intentHash(selection.chain.id, selection.network.id, stored);
    const created = await this.deps.stores.operations.create({
      id: randomId('op'),
      namespace: this.deps.namespace,
      idempotencyKey: key ?? randomId('idem'),
      intentHash: hash,
      context: this.executionContext(target),
      kind: 'transfer',
      state: 'created',
      intent: stored,
      attempts: [],
    });
    if (created.created) {
      this.emitState(created.record, null);
    } else if (created.record.intentHash !== hash) {
      throw new StateError(
        'IDEMPOTENCY_CONFLICT',
        'this idempotency key was already used for a different transfer',
        { context: { operationId: created.record.id } },
      );
    }
    return { record: created.record, stored: created.record.intent };
  }

  protected executionContext(target: OperationTarget): ExecutionContext {
    const { selection, wallet } = target;
    return {
      chain: selection.chain.id,
      network: selection.network.id,
      library: selection.library,
      providers: selection.providerNames,
      indexers: selection.indexerNames,
      wallet: wallet.name,
      ...(selection.signer ? { signer: selection.signer.id } : {}),
      configHash: selection.configHash,
    };
  }

  /**
   * Rejects an Operation of another chain, network or sending address: its reservation
   * lives under a different sequence key, which this target's lease must never touch.
   */
  protected assertOwnedBy(target: OperationTarget, op: OperationRecord): void {
    const { selection, wallet } = target;
    if (
      op.context.chain !== selection.chain.id ||
      op.context.network !== selection.network.id ||
      op.intent.from !== wallet.address.canonical
    ) {
      throw new ValidationError(
        'INVALID_INTENT',
        `operation '${op.id}' belongs to another chain, network or wallet than this handle`,
      );
    }
  }

  /**
   * The address lease of `op`'s own sending address (R32: keyed on the Operation, never on
   * the target's wallet, so a write for a stored Operation needs no signer). Any snapshot
   * of the Operation will do: its chain, network and sender never change.
   */
  protected withAddressLease<T>(
    target: ReadTarget,
    op: OperationRecord,
    fn: (lease: LeaseHandle | undefined) => Promise<T>,
    signal?: AbortSignal,
    options?: { readonly acquireTimeoutMs?: number },
  ): Promise<T> {
    if (!LEASED_ORDERINGS.has(target.pooled.driver.ordering)) return fn(undefined);
    return this.deps.sequences.withLease(this.sequenceKeyOf(op), fn, signal, options);
  }

  /**
   * Serializes one Operation's signing transitions: the wallet's address lease where the
   * ordering needs one, otherwise (expiry ordering) a short per-Operation lock, so two
   * same-key repeats can never both sign it (R24). Its handle is passed down (renewed,
   * heartbeat) exactly like the address lease; it never guards a sequence write.
   */
  protected withOperationLease<T>(
    target: ReadTarget,
    op: OperationRecord,
    fn: (lease: LeaseHandle | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (LEASED_ORDERINGS.has(target.pooled.driver.ordering)) {
      return this.withAddressLease(target, op, fn, signal);
    }
    return this.deps.sequences.withLease(
      `op:${this.deps.namespace}:${op.id}`,
      fn,
      signal,
    );
  }

  /** R32: the sequence key of the Operation's own chain, network and sending address. */
  protected sequenceKeyOf(op: Pick<OperationRecord, 'context' | 'intent'>): string {
    return sequenceKey(
      this.deps.namespace,
      op.context.chain,
      op.context.network,
      op.intent.from,
    );
  }

  protected walletOperations(op: OperationRecord): Promise<OperationRecord[]> {
    return this.deps.stores.operations.list({
      namespace: this.deps.namespace,
      chain: op.context.chain,
      network: op.context.network,
      from: op.intent.from,
    });
  }

  protected async prepareStage(
    target: OperationTarget,
    op: OperationRecord,
    stored: StoredIntent,
    lease: LeaseHandle | undefined,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const driver = target.pooled.driver;
    const key = this.sequenceKeyOf(op);
    let reservation: OrderingData | undefined;
    let persisting = false;
    try {
      let excludeInputs: string[] | undefined;
      if (driver.ordering === 'nonce' || driver.ordering === 'seqno') {
        if (!driver.sequence) {
          throw new StateError(
            'INVALID_TRANSITION',
            `the ${op.context.chain} driver has ${driver.ordering} ordering but no sequence source`,
          );
        }
        if (driver.ordering === 'seqno') {
          reservation = await this.nextSeqno(driver.sequence, op);
        } else {
          const pending = await driver.sequence.pending(stored.from);
          const nonce = await this.deps.sequences.allocate(
            lease as LeaseHandle,
            key,
            pending,
          );
          reservation = { kind: 'nonce', nonce };
          this.deps.events.emit('nonce.allocated', {
            namespace: this.deps.namespace,
            chain: op.context.chain,
            network: op.context.network,
            operationId: op.id,
            value: nonce.toString(),
          });
        }
      } else if (driver.ordering === 'inputs') {
        excludeInputs = reservedInputs(await this.walletOperations(op), op.id);
      }
      const build: BuildContext = {
        from: stored.from,
        keys: target.wallet.keys,
        wallet: target.wallet.options,
        ...(reservation ? { ordering: reservation } : {}),
        ...(excludeInputs ? { excludeInputs } : {}),
        ...(signal ? { signal } : {}),
      };
      const fee = await driver.builder.estimateFee(stored, build);
      const funds = await driver.builder.checkFunds(stored, fee, build);
      if (!funds.ok) {
        throw new ChainError(
          'INSUFFICIENT_FUNDS',
          'insufficient funds for this transfer',
          {
            context: { operationId: op.id },
            details: {
              required: funds.required.toString(),
              available: funds.available.toString(),
            },
          },
        );
      }
      const unsigned = await driver.builder.build(stored, fee, build);
      assertBuiltOrdering(
        op.id,
        driver.ordering,
        reservation,
        excludeInputs,
        unsigned.ordering,
      );
      await lease?.renew();
      persisting = true;
      return await this.update(op, {
        state: 'prepared',
        unsigned,
        reservation: unsigned.ordering,
      });
    } catch (error) {
      // Compensate only when no store write was attempted (a crashed process could not either).
      if (!persisting) {
        if (reservation?.kind === 'nonce' && lease) {
          await this.deps.sequences
            .release(lease, key, reservation.nonce)
            .catch((e: unknown) =>
              this.deps.log.warn('could not release a reserved nonce', {
                operationId: op.id,
                code: errorCode(e),
              }),
            );
        }
        if (isDefinitive(error)) {
          await this.update(op, { state: 'failed', error: serializeError(error) }).catch(
            (e: unknown) =>
              this.deps.log.warn('could not record a failure', {
                operationId: op.id,
                code: errorCode(e),
              }),
          );
        }
      }
      throw error;
    }
  }

  /**
   * `prepare()`'s policy check. M3: bounded like signing, by `lifecycle.signTimeoutMs` and
   * the caller's `signal` (`signingDeadline`), but with no heartbeat: a hook that outlives
   * the lease loses it, and its veto then writes nothing (N1). Only a veto fails the
   * Operation; a timeout or an abort leaves it `prepared` for a repeat to authorize again.
   */
  protected async authorizeOrFail(
    target: OperationTarget,
    op: OperationRecord,
    lease?: LeaseHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    const ctx = this.signingContext(target, op, op.unsigned as UnsignedTx, 'original');
    try {
      await this.signingDeadline(op, undefined, signal, () =>
        this.deps.orchestrator.authorize(ctx),
      );
    } catch (error) {
      if (isCryptoAioError(error, 'POLICY_REJECTED'))
        await this.failAfterPrepare(target, op, error, lease);
      throw error;
    }
  }

  /**
   * Takes an Operation as far as one call can, all under its lease (`withOperationLease`:
   * the address lease, R23, or a per-Operation lock on expiry chains, R24): `created`
   * is prepared, `prepared` is signed into the write-ahead Attempt, and a `signed` (or
   * ambiguously `submitted`) Operation resends its stored raw bytes; it is never signed
   * again. Any other state is returned as it is (`settle` rethrows a stored failure).
   */
  protected async drive(
    target: OperationTarget,
    op: OperationRecord,
    stored: StoredIntent,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    if (op.state !== 'created' && op.state !== 'prepared' && !awaitsBroadcast(op)) {
      return this.settle(op);
    }
    const current = await this.withOperationLease(
      target,
      op,
      async (lease) => {
        let fresh = await this.require(op.id);
        if (fresh.state === 'created') {
          fresh = await this.prepareStage(target, fresh, stored, lease, signal);
        }
        if (fresh.state === 'prepared') {
          fresh = await this.signStage(target, fresh, lease, signal);
        }
        if (awaitsBroadcast(fresh)) {
          fresh = await this.resendActive(target, fresh, signal, lease);
        }
        return fresh;
      },
      signal,
    );
    return this.settle(current);
  }

  /**
   * Runs the policy hook and the signer(s) over the stored unsigned payload, bounded by the
   * lease (`signingDeadline`). A veto or a mismatching signature fails the Operation before
   * signing. A pending result is persisted as `awaiting-signature` with every ticket (R22);
   * a signed one becomes the write-ahead Attempt.
   */
  protected async signStage(
    target: OperationTarget,
    op: OperationRecord,
    lease?: LeaseHandle,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const unsigned = op.unsigned as UnsignedTx;
    const ctx = this.signingContext(target, op, unsigned, 'original');
    const existing = this.usablePartials(op, unsigned.signingRequests);
    let result: OrchestratedResult;
    try {
      result = await this.signingDeadline(
        op,
        lease,
        signal,
        async () => {
          await this.deps.orchestrator.authorize(ctx);
          return this.deps.orchestrator.sign(
            target.wallet,
            unsigned.signingRequests,
            ctx,
            existing,
          );
        },
        // R22: a pending answer after the deadline was never recorded; cancel its tickets.
        async (late) => {
          if (late.status === 'pending')
            await this.cancelTickets(target, op.id, late.tickets);
        },
      );
    } catch (error) {
      if (
        isCryptoAioError(error, 'POLICY_REJECTED') ||
        isCryptoAioError(error, 'SIGNATURE_MISMATCH')
      ) {
        await this.failAfterPrepare(target, op, error, lease);
      }
      throw error;
    }
    if (result.status === 'signed') {
      return this.appendSigned(
        target,
        op,
        unsigned,
        result.signatures,
        'original',
        undefined,
        lease,
      );
    }
    try {
      await lease?.renew();
      return await this.update(op, {
        state: 'awaiting-signature',
        partialSignatures: result.signatures,
        ...(result.tickets.length > 0 ? { signerTickets: result.tickets } : {}),
      });
    } catch (error) {
      // R22: a ticket that was not recorded could never be cancelled later.
      await this.cancelTickets(target, op.id, result.tickets);
      throw error;
    }
  }

  /**
   * Bounds a signer or policy call (they have no deadline of their own) by
   * `lifecycle.signTimeoutMs` and the caller's `signal`, and keeps the held lease alive
   * meanwhile (R24: renewed every `leaseMs / 3`). On timeout, abort or a lost lease nothing
   * is written: the Operation keeps its state and reservation (a late signature may still
   * appear), and a repeat asks again. A lost lease is logged by code, like
   * `failAfterPrepare`. A result that arrives after the wait ended goes to `late` (R22:
   * a pending answer's tickets are cancelled there); otherwise it is dropped.
   */
  protected async signingDeadline<T>(
    op: OperationRecord,
    lease: LeaseHandle | undefined,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
    late?: (result: T) => Promise<void>,
  ): Promise<T> {
    signal?.throwIfAborted();
    await lease?.renew();
    const done = new AbortController();
    const limits: Promise<never>[] = [
      this.deps.clock.sleep(this.deps.lifecycle().signTimeoutMs, done.signal).then(() => {
        throw new TimeoutError(
          'TIMEOUT',
          'the signer or policy hook did not answer within lifecycle.signTimeoutMs',
          { retryable: true, context: { operationId: op.id } },
        );
      }),
    ];
    if (lease) limits.push(this.heartbeat(op, lease, done.signal));
    if (signal) {
      limits.push(
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(abortReason(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          done.signal.addEventListener(
            'abort',
            () => signal.removeEventListener('abort', onAbort),
            { once: true },
          );
        }),
      );
    }
    const running = work();
    let delivered = false;
    try {
      // The limits only ever reject, so resolving means `running` answered in time.
      const result = await Promise.race([running, ...limits]);
      delivered = true;
      return result;
    } finally {
      done.abort();
      if (!delivered && late) {
        // A rejection of `running` itself already surfaced (or lost the race): ignore it.
        running
          .then(late, () => undefined)
          .catch((error: unknown) =>
            this.deps.log.warn('could not handle a late signer answer', {
              operationId: op.id,
              code: errorCode(error),
            }),
          );
      }
    }
  }

  /**
   * Renews `lease` every `max(1, leaseMs / 3)` ms until `stop` aborts. Rejects (after a
   * code-only log) when a renewal fails: the lease was lost to another worker.
   */
  protected async heartbeat(
    op: OperationRecord,
    lease: LeaseHandle,
    stop: AbortSignal,
  ): Promise<never> {
    const every = Math.max(1, Math.floor(this.deps.lifecycle().leaseMs / 3));
    for (;;) {
      await this.deps.clock.sleep(every, stop);
      try {
        await lease.renew();
      } catch (error) {
        if (!stop.aborted) {
          this.deps.log.warn('address lease lost while waiting for the signer', {
            operationId: op.id,
            code: errorCode(error),
          });
        }
        throw error;
      }
    }
  }

  /**
   * Carry-forward: the persisted partial signatures that still verify. A corrupt entry is
   * dropped (its request is signed or submitted again) instead of making `sign()` or
   * `accept()` throw SIGNATURE_MISMATCH on every call, which would strand the Operation.
   */
  protected usablePartials(
    op: OperationRecord,
    requests: readonly SigningRequest[],
  ): SignatureBundle[] {
    const partials: readonly unknown[] = Array.isArray(op.partialSignatures)
      ? op.partialSignatures
      : [];
    const usable: SignatureBundle[] = [];
    for (const partial of partials) {
      try {
        usable.push(
          ...this.deps.orchestrator.accept(requests, [partial as SignatureBundle], []),
        );
      } catch (error) {
        this.deps.log.warn('dropped an unusable partial signature', {
          operationId: op.id,
          code: errorCode(error),
        });
      }
    }
    return usable;
  }

  /**
   * Assembles and persists an immutable Attempt BEFORE any broadcast (write-ahead). `lease`
   * is renewed right before the write (R23): signing may have outlived it, and then
   * nothing is written. When the append loses its compare-and-set to a writer that took the
   * Operation to `signed` or beyond (or ended it), the stored Operation is returned instead
   * (R24), and callers continue from its state; a still pre-signing one rethrows the
   * VERSION_CONFLICT, and an abandoned one is INVALID_TRANSITION. The `signed` Operation is
   * scheduled (`nextCheckAt: now`), like every engine transition after signing.
   *
   * A new Attempt (`supersedes` set: replace, cancel, rebuild) has a stricter lost-CAS
   * contract: the stored Operation is returned only when it shows this very Attempt;
   * otherwise the VERSION_CONFLICT is rethrown (`signNewAttempt` may retry it).
   *
   * The store does not guard transitions, so appending to a terminal Operation is refused
   * here, with one explicit exception: a `rebuild` Attempt reopens an `expired` Operation
   * (Task 27; `rebuild` re-proves every earlier Attempt dead under the lease first). It is
   * the only way out of a terminal state; `update` refuses every other.
   */
  protected async appendSigned(
    target: OperationTarget,
    op: OperationRecord,
    unsigned: UnsignedTx,
    signatures: readonly SignatureBundle[],
    purpose: SigningPurpose,
    supersedes?: string,
    lease?: LeaseHandle,
  ): Promise<OperationRecord> {
    if (isTerminal(op.state) && !(purpose === 'rebuild' && op.state === 'expired')) {
      throw new StateError(
        'INVALID_TRANSITION',
        `operation '${op.id}' is ${op.state}; no ${purpose} attempt can be added`,
        { context: { operationId: op.id } },
      );
    }
    const signed = await target.pooled.driver.builder.assemble(unsigned, signatures);
    const attempt: AttemptRecord = {
      id: randomId('att'),
      ref: signed.ref,
      raw: signed.raw,
      ordering: unsigned.ordering,
      fee: unsigned.fee,
      unsigned,
      purpose,
      ...(supersedes !== undefined ? { supersedes } : {}),
      createdAt: this.deps.clock.now(),
    };
    await lease?.renew();
    let next: OperationRecord;
    try {
      next = await this.deps.stores.operations.appendAttempt(
        this.deps.namespace,
        op.id,
        attempt,
        {
          state: 'signed',
          // R26.1: scheduled from the moment signed bytes exist, so the Operation stays
          // claimable whatever moves it next (a read-only pass never schedules).
          nextCheckAt: attempt.createdAt,
          // M1: a rebuild takes a new slot (seqno); the reservation follows it.
          ...(purpose === 'rebuild' ? { reservation: unsigned.ordering } : {}),
          clear: ['unsigned', 'partialSignatures', 'signerTickets', 'ambiguous', 'error'],
        },
        op.version,
      );
    } catch (error) {
      // R24: another writer changed the Operation first (e.g. appended its own Attempt).
      // These bytes were never persisted or sent, so they are dropped; the caller goes on
      // from the stored Operation instead of surfacing the conflict. Lost-CAS contract:
      // only when that writer took it to `signed` or beyond (or ended it). A stored
      // pre-signing Operation means these signatures were not recorded anywhere, so the
      // conflict is rethrown (a repeat signs again); an abandoned one cannot be signed.
      if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
      const stored = await this.require(op.id);
      if (supersedes !== undefined) {
        if (stored.attempts.some((a) => a.id === attempt.id)) return stored;
        throw error;
      }
      if (stored.state === 'abandoned') {
        throw new StateError(
          'INVALID_TRANSITION',
          `operation '${op.id}' was abandoned while it was being signed`,
          { context: { operationId: op.id } },
        );
      }
      if (PRE_SIGNING_STATES.has(stored.state)) throw error;
      return stored;
    }
    if (next.state !== op.state) this.emitState(next, op.state);
    return next;
  }

  protected activeAttempt(op: OperationRecord): AttemptRecord {
    const attempt = op.attempts.find((a) => a.id === op.activeAttemptId);
    if (!attempt) {
      throw new StateError(
        'INVALID_TRANSITION',
        `operation '${op.id}' has no active attempt`,
        { context: { operationId: op.id } },
      );
    }
    return attempt;
  }

  // ---- new Attempts: replace, cancel, rebuild (spec §8.6) -------------------------------

  /**
   * Replace and cancel, under the Operation's lease (the address lease; the op lock on
   * expiry chains). The new Attempt is built from the active one and must be mutually
   * exclusive with every earlier Attempt (checked before signing; for inputs, exclusion is
   * not transitive) and use the slot `assertBuiltOrdering` expects. It is signed once and
   * persisted before its broadcast (`signNewAttempt`), never re-signed: a repeat whose
   * Attempt was persisted but never, or ambiguously, sent resends its stored bytes
   * (`resumeNewAttempt`). When the node refuses the fresh Attempt, the one it superseded is
   * still live: the Operation goes back to its previous state and active Attempt
   * (`restoreAfterRefusal`) and the node's error is thrown. That refusal is never terminal.
   *
   * R30/R30.1, a repeat of an earlier request (`fee` is the requested spec): the same
   * replacement spec is answered by that replacement (`repeatReplacement`); a cancel is
   * resent, returned, or bumped when refused or dropped (`repeatCancel`). See `replace` and
   * `cancel`.
   */
  protected async createConflicting(
    target: OperationTarget,
    operationId: string,
    purpose: 'replacement' | 'cancel',
    fee: FeeSpeed | FeeOverride | undefined,
    build: (previous: UnsignedTx, ctx: BuildContext) => Promise<UnsignedTx>,
  ): Promise<OperationRecord> {
    const listed = await this.require(operationId);
    const done = await this.withOperationLease(target, listed, async (lease) => {
      let op = await this.require(operationId);
      this.assertOwnedBy(target, op);
      const active = op.attempts.find((a) => a.id === op.activeAttemptId);
      if (purpose === 'replacement') {
        const prior = this.priorReplacement(op, fee);
        const repeated =
          prior && (await this.repeatReplacement(target, op, prior, lease));
        if (repeated) return repeated;
      } else if (active?.purpose === 'cancel') {
        const repeated = await this.repeatCancel(target, op, active, fee, lease);
        if (repeated) return repeated;
        // A new, bumped cancel is built below, from the Operation as it now stands.
        op = await this.require(operationId);
      }
      if (!CONFLICTABLE_STATES.has(op.state)) {
        throw new StateError(
          'INVALID_TRANSITION',
          `cannot create a ${purpose} for an operation in state '${op.state}'`,
          { context: { operationId } },
        );
      }
      const previous = this.activeAttempt(op);
      if (previous.purpose === 'cancel' && purpose === 'replacement') {
        // A replacement would be built from the cancel's own transaction, yet report
        // `executed` if it won.
        throw new StateError(
          'INVALID_TRANSITION',
          'a cancel is in flight and cannot be replaced',
          { context: { operationId } },
        );
      }
      const driver = target.pooled.driver;
      const excludeInputs =
        driver.ordering === 'inputs'
          ? reservedInputs(await this.walletOperations(op), op.id)
          : undefined;
      // N3/R2-1: a cancel climbs from the earlier cancels of this same Attempt (`cancelBase`).
      const base = purpose === 'cancel' ? cancelBase(op, previous) : previous;
      const unsigned = await build(base.unsigned, {
        from: op.intent.from,
        keys: target.wallet.keys,
        wallet: target.wallet.options,
        ...(excludeInputs ? { excludeInputs } : {}),
      });
      if (!op.attempts.every((a) => mutuallyExclusive(unsigned.ordering, a.ordering))) {
        throw new StateError(
          'INVALID_TRANSITION',
          `the ${purpose} would not conflict with every earlier attempt; refusing to risk a double spend`,
          { context: { operationId } },
        );
      }
      assertBuiltOrdering(
        op.id,
        driver.ordering,
        previous.ordering,
        excludeInputs,
        unsigned.ordering,
      );
      const { signed, before } = await this.signNewAttempt(
        target,
        op,
        unsigned,
        purpose,
        CONFLICTABLE_STATES,
        lease,
      );
      try {
        return await this.broadcastActive(target, signed, undefined, lease);
      } catch (error) {
        // Only the node's own answer; an ambiguous failure may have delivered the bytes.
        // M2: back to the snapshot the append was made over, not the read before signing.
        if (isRefusal(error)) {
          await this.restoreAfterRefusal(
            op.id,
            signed.activeAttemptId,
            {
              state: before.state,
              activeAttemptId: previous.id,
              ...(before.error ? { error: before.error } : {}),
              ...(before.ambiguous ? { ambiguous: true } : {}),
            },
            lease,
          );
        }
        throw error;
      }
    });
    return this.settle(done);
  }

  /**
   * R30/N1: the replacement a repeat of this fee spec refers to: the active one made for it,
   * or the latest Attempt when it was made for it and, refused, gave the active role back to
   * the Attempt it superseded. `undefined`: a new request.
   */
  protected priorReplacement(
    op: OperationRecord,
    fee: FeeSpeed | FeeOverride | undefined,
  ): AttemptRecord | undefined {
    const active = op.attempts.find((a) => a.id === op.activeAttemptId);
    if (active?.purpose === 'replacement' && sameFeeSpec(active, fee)) return active;
    const last = op.attempts[op.attempts.length - 1];
    return last?.purpose === 'replacement' &&
      sameFeeSpec(last, fee) &&
      last.supersedes === op.activeAttemptId
      ? last
      : undefined;
  }

  /**
   * R30/N1: a repeat of the request `prior` was made for signs nothing. Its stored bytes are
   * resent when their broadcast was never recorded, was ambiguous, or was refused or
   * rejected (R30.2): the node's current answer decides, and a refusal restores the
   * superseded Attempt and is thrown (`resendActive`), never reported as a success. A
   * `prior` that already gave the active role back is resent first and made active again
   * only once the node accepted it (`resendRestoredAway`). An active `prior` the node holds,
   * or one on chain, is returned as it is. `undefined` (a refused `prior` of an Operation
   * that moved on): the caller goes on as for a new request.
   */
  protected async repeatReplacement(
    target: OperationTarget,
    op: OperationRecord,
    prior: AttemptRecord,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord | undefined> {
    const isActive = prior.id === op.activeAttemptId;
    if (!RESUMABLE_STATES.has(op.state)) return isActive ? op : undefined;
    if (!isActive) return this.resendRestoredAway(target, op, prior, lease);
    const observation = await this.deps.stores.operations.getObservation(prior.id);
    const resend =
      awaitsBroadcast(op) ||
      observation?.lastBroadcastAt === undefined ||
      NODE_REFUSED_STATES.has(observation.state);
    return resend ? this.resendActive(target, op, undefined, lease) : op;
  }

  /**
   * R2-2: resends the stored bytes of a replacement that gave the active role back after a
   * refusal, while the Attempt it superseded stays active. Only once a node accepted them
   * (or they are already seen) is it made active again (`reactivate`) and the acceptance
   * recorded, so a crash in between leaves the superseded Attempt active and never an
   * unaccepted one. A refusal or rejection is thrown and changes nothing; an ambiguous
   * failure leaves the may-be-live marker (`recordAmbiguous`).
   */
  protected async resendRestoredAway(
    target: OperationTarget,
    op: OperationRecord,
    prior: AttemptRecord,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord> {
    const fanout = this.deps.lifecycle().broadcastFanout;
    // R25: read before the send, so no store failure can follow a delivery here.
    const live = mayBeLive(await this.deps.stores.operations.getObservation(prior.id));
    let result: BroadcastResult;
    try {
      result = await target.pooled.driver.broadcaster.broadcast(
        { raw: prior.raw, ref: prior.ref },
        fanout > 1 ? { fanout } : {},
      );
    } catch (error) {
      throw await this.recordAmbiguous(op, prior, error);
    }
    if (result.kind === 'refused' || result.kind === 'rejected') {
      // Spec §8.2: its own ref is looked up first; seen means the node holds it after all.
      // R31: a failed lookup is ambiguous, as on the active resend path.
      let seen: boolean;
      try {
        seen = await this.seenOwnRef(target, op, prior, this.deps.clock.now());
      } catch (error) {
        throw this.ambiguousAfterBroadcast(op, prior, error);
      }
      if (!seen) {
        // R25: as on the active resend path, a rejection of bytes that may be live (a node
        // once accepted them) is only a refusal.
        const rejected = result.kind === 'rejected' && !live;
        const refusedCode = result.kind === 'refused' ? result.code : 'TX_REFUSED';
        throw new ChainError(
          rejected ? 'TX_REJECTED' : refusedCode,
          `transaction ${rejected ? 'rejected' : 'refused'}: ${result.reason}`,
          { context: { operationId: op.id, attemptId: prior.id } },
        );
      }
    }
    let current: OperationRecord;
    try {
      current = await this.reactivate(op, prior, lease);
    } catch (error) {
      // R27: the node holds the bytes, so a failure to record that is ambiguous.
      throw this.ambiguousAfterBroadcast(op, prior, error);
    }
    return this.applyBroadcastResult(
      target,
      current,
      prior,
      { kind: 'already-known' },
      lease,
    );
  }

  /**
   * Makes a refused new Attempt active again, only while the Attempt it superseded is still
   * the active one and nothing was appended since (compare-and-set, re-derived after a lost
   * one). Otherwise VERSION_CONFLICT (retryable).
   */
  protected async reactivate(
    op: OperationRecord,
    attempt: AttemptRecord,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord> {
    await lease?.renew();
    const next = await this.updateAfterBroadcast(op, (current) =>
      current.activeAttemptId === attempt.supersedes &&
      current.attempts.length === op.attempts.length
        ? { activeAttemptId: attempt.id }
        : undefined,
    );
    if (next.activeAttemptId !== attempt.id) {
      throw new StateError('VERSION_CONFLICT', `operation '${op.id}' kept changing`, {
        context: { operationId: op.id },
      });
    }
    return next;
  }

  /**
   * R30.1: a cancel while a cancel is the active Attempt. Its stored bytes are resent when
   * their broadcast was never recorded or was ambiguous; it is returned unchanged while a
   * node holds it (`pending`, `mempool`) and once it is on chain (chain evidence), so
   * concurrent and retried cancels are idempotent. `undefined` asks the caller for a new,
   * bumped cancel: only when the cancel is recorded `refused`, `rejected` (R30.2) or
   * `dropped`, or for an explicit `fee` while it is not on chain. A refused or rejected one
   * first gives the active role back to the Attempt it superseded (N1), so it is never
   * reported as a success.
   */
  protected async repeatCancel(
    target: OperationTarget,
    op: OperationRecord,
    active: AttemptRecord,
    fee: FeeSpeed | FeeOverride | undefined,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord | undefined> {
    const resumed = await this.resumeNewAttempt(target, op, 'cancel', lease);
    if (resumed) return resumed;
    const observation = await this.deps.stores.operations.getObservation(active.id);
    if (observation && CHAIN_EVIDENCE_STATES.has(observation.state)) return op;
    const refused = observation !== null && NODE_REFUSED_STATES.has(observation.state);
    if (!refused && observation?.state !== 'dropped' && fee === undefined) return op;
    if (refused) await this.undoRefusedResend(op.id, active, lease);
    return undefined;
  }

  /**
   * A repeat of a replace, cancel or rebuild whose Attempt was persisted but never sent (no
   * broadcast recorded: a crash after `appendAttempt`) or sent with an unknown outcome
   * (ambiguous): its stored bytes are resent, never signed again, so a retry creates no
   * second new Attempt. `undefined` when there is nothing to resume.
   *
   * The resend goes through `resendActive`: a refusal restores the superseded Attempt.
   */
  protected async resumeNewAttempt(
    target: OperationTarget,
    op: OperationRecord,
    purpose: Exclude<AttemptPurpose, 'original'>,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord | undefined> {
    const active = op.attempts.find((a) => a.id === op.activeAttemptId);
    if (active?.purpose !== purpose || !RESUMABLE_STATES.has(op.state)) return undefined;
    if (!awaitsBroadcast(op)) {
      const observation = await this.deps.stores.operations.getObservation(active.id);
      if (observation?.lastBroadcastAt !== undefined) return undefined;
    }
    return this.resendActive(target, op, undefined, lease);
  }

  /**
   * Resends the active Attempt's stored bytes (`broadcastActive`) for every resend path:
   * `rebroadcast` (and so recovery), a same-key `transfer` and a repeated replace, cancel or
   * rebuild. I2/N1: when the node refuses a resent replacement or cancel, the Attempt it
   * superseded becomes active again (`undoRefusedResend`) and the refusal is thrown, so it is
   * never reported as a success. A refused rebuild stays `stalled` (see `rebuild`).
   */
  protected async resendActive(
    target: OperationTarget,
    op: OperationRecord,
    signal: AbortSignal | undefined,
    lease: LeaseHandle | undefined,
  ): Promise<OperationRecord> {
    try {
      return await this.broadcastActive(target, op, signal, lease);
    } catch (error) {
      const active = op.attempts.find((a) => a.id === op.activeAttemptId);
      if (isRefusal(error) && active) await this.undoRefusedResend(op.id, active, lease);
      throw error;
    }
  }

  /**
   * N2: after a resend of a replacement or cancel was refused, the Attempt it superseded
   * becomes active again. The state it was appended over is not recorded, so it is derived
   * from the superseded Attempt's observation: when that one may still be live (`pending`,
   * `mempool`, `included`), the Operation returns to `submitted`; otherwise (e.g. the
   * original was itself refused) only the active Attempt is swapped and the Operation keeps
   * its `stalled` state and stored error. Nothing for an original or a rebuild.
   */
  protected async undoRefusedResend(
    operationId: string,
    refused: AttemptRecord,
    lease: LeaseHandle | undefined,
  ): Promise<void> {
    const superseded = refused.supersedes;
    if (superseded === undefined || refused.purpose === 'rebuild') return;
    let live = false;
    try {
      const observation = await this.deps.stores.operations.getObservation(superseded);
      live = observation !== null && LIVE_STATES.has(observation.state);
    } catch (error) {
      // Undecided: swap only the active Attempt (the safe, non-terminal choice).
      this.deps.log.warn('could not read the superseded attempt', {
        operationId,
        code: errorCode(error),
      });
    }
    await this.restoreAfterRefusal(
      operationId,
      refused.id,
      live
        ? { state: 'submitted', activeAttemptId: superseded }
        : { activeAttemptId: superseded },
      lease,
    );
  }

  /**
   * Signs a new Attempt once and persists it (write-ahead) before any broadcast. The policy
   * hook and the signer are bounded by `lifecycle.signTimeoutMs`, with the lease renewed
   * meanwhile (`signingDeadline`). A pending answer is refused, since new Attempts need a
   * synchronous signer, and its tickets are cancelled through their issuers (R22), as are
   * those of a pending answer that arrives after the deadline. A veto, a timeout or a bad
   * signature writes nothing.
   *
   * A lost compare-and-set (e.g. a worker's claim bumped the version) is retried with the
   * same signatures under the same lease while the re-read Operation is still `eligible`
   * with the same Attempts. Otherwise the VERSION_CONFLICT is rethrown and these bytes,
   * never persisted or sent, are dropped. Success is returned only when the stored
   * Operation shows the new Attempt (`appendSigned`): `signed`, together with `before`, the
   * snapshot the successful append was made over (M2: what a refusal restores).
   */
  protected async signNewAttempt(
    target: OperationTarget,
    op: OperationRecord,
    unsigned: UnsignedTx,
    purpose: Exclude<AttemptPurpose, 'original'>,
    eligible: ReadonlySet<OperationState>,
    lease: LeaseHandle | undefined,
  ): Promise<{ readonly signed: OperationRecord; readonly before: OperationRecord }> {
    const supersedes = this.activeAttempt(op).id;
    const ctx = this.signingContext(target, op, unsigned, purpose);
    const result = await this.signingDeadline(
      op,
      lease,
      undefined,
      async () => {
        await this.deps.orchestrator.authorize(ctx);
        return this.deps.orchestrator.sign(target.wallet, unsigned.signingRequests, ctx);
      },
      async (late) => {
        if (late.status === 'pending')
          await this.cancelTickets(target, op.id, late.tickets);
      },
    );
    if (result.status === 'pending') {
      await this.cancelTickets(target, op.id, result.tickets);
      throw new SigningError(
        'SIGNING_FAILED',
        `${purpose} attempts need a synchronous signer`,
        { context: { operationId: op.id } },
      );
    }
    let current = op;
    for (let tries = 1; ; tries++) {
      try {
        const signed = await this.appendSigned(
          target,
          current,
          unsigned,
          result.signatures,
          purpose,
          supersedes,
          lease,
        );
        return { signed, before: current };
      } catch (error) {
        if (!isCryptoAioError(error, 'VERSION_CONFLICT') || tries >= 5) throw error;
        current = await this.require(op.id);
        if (
          !eligible.has(current.state) ||
          current.activeAttemptId !== supersedes ||
          current.attempts.length !== op.attempts.length
        )
          throw error;
      }
    }
  }

  /**
   * Spec §8.6: the node refused a replacement or cancel, so the Attempt it superseded is
   * still the live one and keeps its nonce. While the refused Attempt is still the active
   * one (M3) and the Operation is not terminal (M-b: an ended Operation is left alone),
   * the superseded one becomes active again. When the Operation still shows the refusal
   * (`stalled`, or `signed` after a rejection) and `point` names a state, it also returns
   * to `point`'s state, error and ambiguity; any other state (`included`, `submitted` or
   * later) is the monitor's and is kept. The refused Attempt stays recorded and monitored.
   * The lease is renewed first. A failure is only logged: the caller gets the node's error
   * either way, and the Operation stays safely `stalled`.
   */
  protected async restoreAfterRefusal(
    operationId: string,
    refusedId: string | undefined,
    point: RestorePoint,
    lease: LeaseHandle | undefined,
  ): Promise<void> {
    const clear: ClearableField[] = [];
    if (!point.error) clear.push('error');
    if (!point.ambiguous) clear.push('ambiguous');
    const full: OperationPatch = {
      state: point.state,
      activeAttemptId: point.activeAttemptId,
      ...(point.error ? { error: point.error } : {}),
      ...(point.ambiguous ? { ambiguous: true } : {}),
      ...(clear.length > 0 ? { clear } : {}),
    };
    try {
      await lease?.renew();
      await this.updateAfterBroadcast(await this.require(operationId), (current) => {
        if (current.activeAttemptId !== refusedId || isTerminal(current.state))
          return undefined;
        return point.state !== undefined &&
          (current.state === 'stalled' || current.state === 'signed')
          ? full
          : { activeAttemptId: point.activeAttemptId };
      });
    } catch (error) {
      this.deps.log.warn('could not restore the attempt a refused one superseded', {
        operationId,
        code: errorCode(error),
      });
    }
  }

  /**
   * Rebuild's precondition, re-proved from finalized state (quorum proof reads), never
   * taken from stored observations: each earlier Attempt's expiry passed, or (seqno)
   * another transaction consumed its slot, per finalized state, and only then is it
   * confirmed not included at finality. In that order, as the monitor does: any inclusion
   * would lie at or below the already finalized expiry or slot, so the later read sees it.
   * Otherwise INVALID_TRANSITION; nothing is written.
   */
  protected async assertAttemptsDead(
    target: OperationTarget,
    op: OperationRecord,
  ): Promise<void> {
    const { proofs } = target.pooled.driver;
    const from = op.intent.from;
    for (const attempt of op.attempts) {
      const { ordering } = attempt;
      const unreachable =
        (await proofs.expired(ordering)) ||
        (ordering.kind === 'seqno' &&
          (await proofs.slotConsumed(ordering, from, 'finalized')));
      const dead =
        unreachable &&
        !(await proofs.includedFinal(attempt.ref, ordering, from)).included;
      if (!dead) {
        throw new StateError(
          'INVALID_TRANSITION',
          'an earlier attempt is not provably dead; refusing to rebuild',
          { context: { operationId: op.id, attemptId: attempt.id } },
        );
      }
    }
  }

  /**
   * The wallet's next seqno as a reservation. Seqno wallets are strictly serial: another
   * live Operation that may still consume the current seqno makes this SEQUENCE_BUSY.
   */
  protected async nextSeqno(
    sequence: SequenceSource,
    op: OperationRecord,
  ): Promise<OrderingData> {
    const holder = seqnoHolder(await this.walletOperations(op), op.id);
    if (holder) {
      throw new StateError(
        'SEQUENCE_BUSY',
        'the wallet has another operation in flight (seqno wallets are strictly serial)',
        {
          retryable: true,
          context: { operationId: op.id, blockingOperationId: holder.id },
        },
      );
    }
    return {
      kind: 'seqno',
      seqno: await sequence.pending(op.intent.from),
      validUntil: 0,
    };
  }

  protected get observationDeps(): ObservationDeps {
    return {
      operations: this.deps.stores.operations,
      events: this.deps.events,
      namespace: this.deps.namespace,
    };
  }

  /**
   * Sends the active Attempt's stored raw bytes. `lease` is the held address lease (every
   * caller holds it, R23; leases are not reentrant): a rejection's terminal write and
   * release run under it.
   */
  protected async broadcastActive(
    target: OperationTarget,
    op: OperationRecord,
    signal?: AbortSignal,
    lease?: LeaseHandle,
  ): Promise<OperationRecord> {
    const attempt = this.activeAttempt(op);
    const fanout = this.deps.lifecycle().broadcastFanout;
    let result: BroadcastResult;
    try {
      result = await target.pooled.driver.broadcaster.broadcast(
        { raw: attempt.raw, ref: attempt.ref },
        { ...(fanout > 1 ? { fanout } : {}), ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      throw await this.recordAmbiguous(op, attempt, error, signal);
    }
    return this.applyBroadcastResult(target, op, attempt, result, lease);
  }

  /**
   * The broadcast may have reached the network: a transport failure, an RPC error after a
   * possibly delivered attempt (`ambiguous`), or a caller abort (which the transport
   * surfaces bare). The Operation becomes `submitted` + `ambiguous` and is monitored; it is
   * never failed and keeps its reservation. A retry with the same key resends the stored
   * bytes. The observation is written first and on its own, then the transition, re-derived
   * after a lost compare-and-set; a store failure is only logged: the caller must get the
   * ambiguous error.
   * R28 (spec §13): `ambiguous: true` means the outcome is unknown and the caller retries
   * with the same idempotency key; the error keeps its code and that code's retryability.
   */
  protected async recordAmbiguous(
    op: OperationRecord,
    attempt: AttemptRecord,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<CryptoAioError> {
    const now = this.deps.clock.now();
    const logFailure = (storeError: unknown) =>
      this.deps.log.warn('could not record an ambiguous broadcast', {
        operationId: op.id,
        code: errorCode(storeError),
      });
    // First, and on its own: the observation is the may-be-live marker (R25) a later
    // rejection must see, whatever happens to the Operation write below. As in `accept()`,
    // a missing, `refused` or `dropped` one becomes `pending`: this send may have delivered
    // the bytes. Stronger evidence (chain or proven states) is never overwritten (R24).
    await writeObservation(this.observationDeps, attempt, op.id, (current) => ({
      lastBroadcastAt: now,
      ...(current === null || current.state === 'refused' || current.state === 'dropped'
        ? { state: 'pending' as const }
        : {}),
    })).catch(logFailure);
    // R26.2: re-derived after a lost compare-and-set (e.g. a worker's claim mid-broadcast).
    await this.updateAfterBroadcast(op, (current) =>
      current.state === 'signed' || current.state === 'stalled'
        ? { state: 'submitted', ambiguous: true, nextCheckAt: now, clear: ['error'] }
        : undefined,
    ).catch(logFailure);
    const cause = isCryptoAioError(error)
      ? error
      : signal?.aborted
        ? new TimeoutError(
            'TIMEOUT',
            'the broadcast was aborted; the transaction may have reached the network',
            { cause: sanitizeError(error) },
          )
        : new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'broadcast failed; the transaction may have reached the network',
            { cause: sanitizeError(error) },
          );
    return withContext(
      cause,
      { operationId: op.id, attemptId: attempt.id },
      { ambiguous: true },
    );
  }

  /**
   * Spec §8.2/§8.3. accepted / already-known → `submitted` (an `included` Operation is never
   * downgraded); the acceptance is remembered on the observation (`firstSeenAt`). refused
   * and rejected → the Attempt's own ref is looked up first (seen means it was ours all
   * along). R24/R25: an `included` Operation, or an Attempt whose observation holds chain
   * evidence (mined, replaced or expired), is never stalled, failed or released by a later
   * answer, and a rejection of bytes a node once accepted counts only as a refusal.
   * Otherwise refused → `stalled`, keeping the nonce; rejected (proven invalid) → `failed`
   * with the nonce released, once every Attempt is rejected.
   *
   * R26.2: the node's own refusal or rejection is thrown as it is; any other failure while
   * recording the answer (the bytes may have reached the network) is thrown `ambiguous`
   * with `operationId`, so a caller retries with the same key instead of paying again.
   */
  protected async applyBroadcastResult(
    target: OperationTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    result: BroadcastResult,
    lease?: LeaseHandle,
  ): Promise<OperationRecord> {
    let outcome: OperationRecord | ChainError;
    try {
      outcome = await this.recordBroadcastResult(target, op, attempt, result, lease);
    } catch (error) {
      throw this.ambiguousAfterBroadcast(op, attempt, error);
    }
    if (outcome instanceof ChainError) throw outcome;
    return outcome;
  }

  /** `applyBroadcastResult`'s transitions; returns (never throws) the node's own answer. */
  protected async recordBroadcastResult(
    target: OperationTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    result: BroadcastResult,
    lease?: LeaseHandle,
  ): Promise<OperationRecord | ChainError> {
    const now = this.deps.clock.now();
    const accept = async (acknowledged: boolean): Promise<OperationRecord> => {
      await writeObservation(this.observationDeps, attempt, op.id, (current) => ({
        lastBroadcastAt: now,
        ...(acknowledged ? { firstSeenAt: current?.firstSeenAt ?? now } : {}),
        ...(current === null || current.state === 'refused' || current.state === 'dropped'
          ? { state: 'pending' as const }
          : {}),
      }));
      // R26.2: re-derived from the stored Operation after a lost compare-and-set. An
      // unscheduled one is scheduled, since a read-only pass may have moved it meanwhile.
      return this.updateAfterBroadcast(op, (current) => {
        if (isTerminal(current.state)) return undefined;
        const moves = current.state === 'signed' || current.state === 'stalled';
        if (!moves && current.ambiguous !== true && current.nextCheckAt !== undefined)
          return undefined;
        return {
          ...(moves ? { state: 'submitted' as const } : {}),
          nextCheckAt: now,
          clear: ['ambiguous', 'error'],
        };
      });
    };
    if (result.kind === 'accepted' || result.kind === 'already-known')
      return accept(true);
    // refused or rejected: first the Attempt's own ref (spec §8.2): seen means it was ours.
    if (await this.seenOwnRef(target, op, attempt, now)) return accept(true);
    // R24: the monitor owns included Operations; a lagging answer never downgrades them.
    if (op.state === 'included') return op;
    const context = { operationId: op.id, attemptId: attempt.id };
    // R24/R25: compare-and-set against the current observation, so chain evidence the
    // engine already holds is never overwritten, and a rejection of bytes that may be live
    // is recorded as the refusal it is.
    const saved = await writeObservation(
      this.observationDeps,
      attempt,
      op.id,
      (current): ObservationPatch => {
        if (current && CHAIN_EVIDENCE_STATES.has(current.state))
          return { lastBroadcastAt: now };
        const live = mayBeLive(current);
        const proven = result.kind === 'rejected' && !live;
        return {
          state: proven ? 'rejected' : 'refused',
          evidence: proven ? 'proven' : 'observed',
          reason: result.reason,
          lastBroadcastAt: now,
          // I2: the `refused` state overwrites the live one, so the marker keeps a later
          // rejection seeing these bytes as possibly live (e.g. after an ambiguous send).
          ...(live ? { firstSeenAt: current?.firstSeenAt ?? now } : {}),
        };
      },
    );
    if (CHAIN_EVIDENCE_STATES.has(saved.state))
      return result.kind === 'refused' ? accept(false) : op;
    if (saved.state === 'refused') {
      const error = new ChainError(
        result.kind === 'refused' ? result.code : 'TX_REFUSED',
        `transaction refused: ${result.reason}`,
        { context },
      );
      let stalls = false;
      const next = await this.updateAfterBroadcast(op, async (current) => {
        stalls = false;
        if (isTerminal(current.state) || current.state === 'included') return undefined;
        // After a lost compare-and-set: stronger evidence may have replaced the refusal.
        if (current !== op) {
          const observation = await this.deps.stores.operations.getObservation(
            attempt.id,
          );
          if (observation?.state !== 'refused') return undefined;
        }
        stalls = true;
        return {
          state: 'stalled',
          error: error.toJSON(),
          nextCheckAt: now,
          clear: ['ambiguous'],
        };
      });
      if (stalls) {
        this.deps.events.emit('operation.stalled', {
          namespace: this.deps.namespace,
          operationId: op.id,
          code: error.code,
        });
      }
      // M3: a new Attempt's refusal is always the answer, even when the Operation moved on
      // meanwhile (e.g. the Attempt it superseded was mined): never success for its call.
      return next.state === 'stalled' || attempt.supersedes !== undefined ? error : next;
    }
    const error = new ChainError(
      'TX_REJECTED',
      `transaction rejected: ${result.reason}`,
      {
        context,
      },
    );
    await this.failRejected(target, op, { lease, error });
    return error;
  }

  /**
   * R26.3: the all-rejected verdict. Once every Attempt is proven `rejected`, no valid
   * signed bytes exist for the nonce: the Operation fails and the nonce is released in the
   * same step, under the address lease (R23, spec §8.5), whoever reaches the verdict (the
   * broadcast path or the monitor). Under the lease it re-reads the Operation, re-checks
   * the verdict and renews the lease before the terminal compare-and-set; a lost lease or a
   * verdict that no longer holds writes nothing and returns the stored Operation. Pass the
   * held lease when already inside `withAddressLease` (it is not re-entrant).
   *
   * Without a held lease (the monitor), the lease wait is bounded by `signal` as well as
   * `acquireTimeoutMs` (the option overrides it; `0` tries once); a busy lease, or a target
   * whose wallet no longer owns the Operation (e.g. re-pointed to another key), writes
   * nothing, logs the code and returns `op`. An abort is rethrown. A worker passes its
   * claim `fence`: the terminal write carries it, and a claim taken over by another worker
   * (FENCING) writes nothing, logs the code and returns the stored Operation.
   */
  async failRejected(
    target: OperationTarget,
    op: OperationRecord,
    options: {
      readonly lease?: LeaseHandle;
      readonly error?: CryptoAioError;
      readonly signal?: AbortSignal;
      readonly acquireTimeoutMs?: number;
      readonly fence?: Fence;
    } = {},
  ): Promise<OperationRecord> {
    const { lease, error, signal, acquireTimeoutMs, fence } = options;
    try {
      this.assertOwnedBy(target, op);
    } catch (mismatch) {
      this.deps.log.warn('the resolved wallet does not own the operation', {
        operationId: op.id,
        code: errorCode(mismatch),
      });
      return op;
    }
    if (!lease && LEASED_ORDERINGS.has(target.pooled.driver.ordering)) {
      let acquired = false;
      try {
        return await this.withAddressLease(
          target,
          op,
          (held) => {
            acquired = true;
            return this.failRejected(target, op, {
              error,
              lease: held,
              ...(fence ? { fence } : {}),
            });
          },
          signal,
          acquireTimeoutMs === undefined ? undefined : { acquireTimeoutMs },
        );
      } catch (leaseError) {
        if (acquired || signal?.aborted) throw leaseError;
        this.deps.log.warn('address lease unavailable for a terminal write', {
          operationId: op.id,
          code: errorCode(leaseError),
        });
        return op;
      }
    }
    const reason =
      error ??
      new ChainError('TX_REJECTED', 'every attempt was rejected as invalid', {
        context: { operationId: op.id },
      });
    for (let tries = 0; tries < 5; tries++) {
      const current = await this.require(op.id);
      if (isTerminal(current.state) || !(await this.everyAttemptRejected(current)))
        return current;
      try {
        await lease?.renew();
      } catch (renewError) {
        this.deps.log.warn('address lease lost before a terminal write', {
          operationId: op.id,
          code: errorCode(renewError),
        });
        return current;
      }
      let failed: OperationRecord;
      try {
        failed = await this.update(
          current,
          {
            state: 'failed',
            error: serializeError(reason),
            clear: ['ambiguous', 'nextCheckAt'],
          },
          fence,
        );
      } catch (updateError) {
        if (isCryptoAioError(updateError, 'VERSION_CONFLICT')) continue;
        if (fence && isCryptoAioError(updateError, 'FENCING')) {
          this.deps.log.debug('claim lost before a terminal write', {
            operationId: op.id,
            code: updateError.code,
          });
          return current;
        }
        throw updateError;
      }
      try {
        await this.releaseReservation(current, lease);
      } catch (releaseError) {
        this.deps.log.warn('reservation release failed', {
          operationId: op.id,
          code: errorCode(releaseError),
        });
      }
      return failed;
    }
    throw new StateError('VERSION_CONFLICT', `operation '${op.id}' kept changing`, {
      context: { operationId: op.id },
    });
  }

  /**
   * Nonce reconciliation, never a filler transaction (spec). Under the address lease,
   * returns to `released` every value in [floor, next) that no live Operation of
   * `op`'s wallet reserves, so the next allocation reuses it and the transfers waiting
   * behind the gap can land; `floor` is `consumedFloor` (never below a nonce the chain
   * consumed at finality), and the wallet's history is read only when some value is
   * reclaimable at all. It closes the leaks a release cannot: a crash between
   * allocation and the `prepared` write, a store failure inside a release after a terminal
   * write, and a failure recorded without a release. R29: every live `created` Operation
   * without a reservation is fenced first (`fenceStalePrepare`), so a `prepared` write
   * still in flight from a lapsed lease can never land on a released value (a legitimate
   * transfer re-reads its Operation under the lease). Returns the reclaimed values. The
   * lease wait is bounded by `signal` and `acquireTimeoutMs` (`0` tries once); a busy lease
   * rejects with SEQUENCE_BUSY. A target whose wallet does not own `op` is refused
   * (INVALID_INTENT): its lease guards another sequence.
   */
  async reconcileNonces(
    target: OperationTarget,
    op: OperationRecord,
    options: { readonly signal?: AbortSignal; readonly acquireTimeoutMs?: number } = {},
  ): Promise<readonly bigint[]> {
    const { driver } = target.pooled;
    const sequence = driver.sequence;
    if (driver.ordering !== 'nonce' || !sequence) return [];
    this.assertOwnedBy(target, op);
    const { signal, acquireTimeoutMs } = options;
    return this.withAddressLease(
      target,
      op,
      async (lease) => {
        const wallet = {
          namespace: this.deps.namespace,
          chain: op.context.chain,
          network: op.context.network,
          from: op.intent.from,
        };
        const key = this.sequenceKeyOf(op);
        const chainPending = await sequence.pending(op.intent.from);
        const live = await this.deps.stores.operations.list({
          ...wallet,
          states: NON_TERMINAL_STATES,
        });
        // Cheap first: with nothing reclaimable, neither the fencing writes nor the
        // wallet's history are needed (fencing only ever adds held values).
        const state = await this.deps.stores.sequences.get(key);
        if (!hasReclaimable(state, chainPending, live.flatMap(heldNonces))) return [];
        const held: bigint[] = [];
        for (const record of live)
          held.push(...heldNonces(await this.fenceStalePrepare(record)));
        const floor = await this.consumedFloor(wallet, chainPending);
        await lease?.renew();
        return this.deps.sequences.reclaim(lease as LeaseHandle, key, floor, held);
      },
      signal,
      acquireTimeoutMs === undefined ? undefined : { acquireTimeoutMs },
    );
  }

  /**
   * The lowest value reconciliation may reclaim: `chainPending` (a lagging endpoint can
   * under-report it), raised above every nonce the chain consumed at finality, i.e. those
   * of `final` Operations and of failures proven on chain (`TX_REVERTED`, `TX_REPLACED`).
   * A rejection, a failure before signing or an abandoned Operation consumed nothing.
   */
  protected async consumedFloor(
    wallet: Omit<OperationFilter, 'states' | 'limit'>,
    chainPending: bigint,
  ): Promise<bigint> {
    let floor = chainPending;
    const history = await this.deps.stores.operations.list({
      ...wallet,
      states: ['final', 'failed'],
    });
    for (const record of history) {
      if (record.state === 'failed' && !CONSUMED_FAILURES.has(record.error?.code ?? ''))
        continue;
      for (const nonce of heldNonces(record)) if (nonce >= floor) floor = nonce + 1n;
    }
    return floor;
  }

  /**
   * R29: a `created` Operation without a reservation may still have a `prepared` write in
   * flight from a process whose lease lapsed (it allocated a nonce, renewed, then stalled).
   * A no-effect compare-and-set at the listed version makes that stale write lose its own
   * compare-and-set, so it can never land a reservation on a value this reconciliation
   * releases. After a lost compare-and-set the re-read Operation is returned, and any
   * reservation it now shows counts as held. Other Operations are returned as listed.
   */
  protected async fenceStalePrepare(record: OperationRecord): Promise<OperationRecord> {
    if (record.state !== 'created' || record.reservation !== undefined) return record;
    try {
      return await this.update(record, { clear: ['error'] });
    } catch (error) {
      if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
      return this.require(record.id);
    }
  }

  protected async everyAttemptRejected(op: OperationRecord): Promise<boolean> {
    const observations = await Promise.all(
      op.attempts.map((a) => this.deps.stores.operations.getObservation(a.id)),
    );
    return (
      observations.length > 0 &&
      observations.every((o) => o?.state === 'rejected' && o.evidence === 'proven')
    );
  }

  /**
   * R26.2: a post-broadcast Operation write. After a lost compare-and-set the Operation is
   * re-read and `patchFor` re-derives the transition from it; `undefined` means the stored
   * state already reflects it (or it no longer applies), and the stored Operation is
   * returned.
   */
  protected async updateAfterBroadcast(
    op: OperationRecord,
    patchFor: (
      current: OperationRecord,
    ) => OperationPatch | undefined | Promise<OperationPatch | undefined>,
  ): Promise<OperationRecord> {
    let current = op;
    for (let tries = 0; tries < 5; tries++) {
      const patch = await patchFor(current);
      if (!patch) return current;
      try {
        return await this.update(current, patch);
      } catch (error) {
        if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
        current = await this.require(op.id);
      }
    }
    throw new StateError('VERSION_CONFLICT', `operation '${op.id}' kept changing`, {
      context: { operationId: op.id },
    });
  }

  /**
   * R26.2/R27: a failure after the bytes may have reached the network is always an
   * ambiguous STATE_UNRECORDED (retryable by its catalogue entry, so no other code's
   * retryability is overridden), naming the Operation and the original code.
   */
  protected ambiguousAfterBroadcast(
    op: OperationRecord,
    attempt: AttemptRecord,
    error: unknown,
  ): CryptoAioError {
    return new StateError(
      'STATE_UNRECORDED',
      'the broadcast outcome could not be recorded; the transaction may have reached the network',
      {
        ambiguous: true,
        cause: sanitizeError(error),
        context: { operationId: op.id, attemptId: attempt.id },
        details: { causeCode: errorCode(error) },
      },
    );
  }

  /**
   * Spec §8.2: before a refusal or rejection is believed, looks the Attempt's own ref up.
   * A failed lookup decides nothing: the Operation is scheduled for the monitor (as the
   * ambiguous path does) and the error names it.
   */
  protected async seenOwnRef(
    target: OperationTarget,
    op: OperationRecord,
    attempt: AttemptRecord,
    now: number,
  ): Promise<boolean> {
    try {
      const own = await target.pooled.driver.reader.observe(
        attempt.ref,
        attempt.ordering,
        op.intent.from,
      );
      return own.seen !== 'none';
    } catch (error) {
      await this.update(op, { nextCheckAt: now }).catch((storeError: unknown) =>
        this.deps.log.warn('could not schedule a check', {
          operationId: op.id,
          code: errorCode(storeError),
        }),
      );
      const cause = isCryptoAioError(error)
        ? error
        : new ProviderError('PROVIDER_UNAVAILABLE', 'own-transaction lookup failed', {
            cause: sanitizeError(error),
          });
      throw withContext(cause, { operationId: op.id, attemptId: attempt.id });
    }
  }

  /**
   * Terminal failure before any signed bytes exist (after signing, see `failRejected`):
   * mark failed, then free the nonce, both under one address lease (R23). Callers already inside `withAddressLease` must pass their lease (it is not
   * re-entrant); a caller without one gets it acquired first (acquire → renew → CAS →
   * release, never CAS before acquire). The lease is renewed first: when it was lost (a
   * slow policy hook or signer outlived it), nothing is written, the Operation keeps its
   * state, its next repeat retries under a fresh lease, and the original `error` is
   * rethrown. Returning means the terminal write landed; a failed release after it is only
   * logged (callers rethrow their own error either way). Logs carry codes only.
   */
  protected async failAfterPrepare(
    target: OperationTarget,
    op: OperationRecord,
    error: unknown,
    lease?: LeaseHandle,
  ): Promise<OperationRecord> {
    if (!lease && LEASED_ORDERINGS.has(target.pooled.driver.ordering)) {
      return this.withAddressLease(target, op, (held) =>
        this.failAfterPrepare(target, op, error, held),
      );
    }
    try {
      await lease?.renew();
    } catch (renewError) {
      this.deps.log.warn('address lease lost before a terminal write', {
        operationId: op.id,
        code: errorCode(renewError),
      });
      throw error;
    }
    const failed = await this.update(op, {
      state: 'failed',
      error: serializeError(error),
      clear: ['unsigned', 'partialSignatures', 'signerTickets', 'ambiguous'],
    });
    try {
      await this.releaseReservation(op, lease);
    } catch (releaseError) {
      this.deps.log.warn('reservation release failed', {
        operationId: op.id,
        code: errorCode(releaseError),
      });
    }
    return failed;
  }

  /**
   * Returns the Operation's reserved nonce under the held address lease. Call at most once
   * per allocation, only after the Operation's terminal CAS made under that same lease.
   * There is no lease-less fallback: acquiring a lease only after the CAS could fail and
   * leak the nonce (R23), so a missing lease for a nonce is a programming error.
   */
  protected async releaseReservation(
    op: OperationRecord,
    lease: LeaseHandle | undefined,
  ): Promise<void> {
    const reservation = op.reservation;
    if (reservation?.kind !== 'nonce') return;
    if (!lease) {
      throw new StateError(
        'INVALID_TRANSITION',
        'a nonce is released only under the address lease of its terminal write',
        { context: { operationId: op.id } },
      );
    }
    await this.deps.sequences.release(lease, this.sequenceKeyOf(op), reservation.nonce);
  }

  protected signingContext(
    target: OperationTarget,
    op: OperationRecord,
    unsigned: UnsignedTx,
    purpose: SigningPurpose,
  ): SigningContext {
    return {
      operationId: op.id,
      namespace: this.deps.namespace,
      chain: op.context.chain,
      network: op.context.network,
      wallet: target.wallet.name,
      ...(target.wallet.tier !== undefined ? { tier: target.wallet.tier } : {}),
      purpose,
      summary: unsigned.summary,
      fee: unsigned.fee,
      unsignedHash: sha256Hex(canonicalJson(unsigned.payload)),
    };
  }

  /**
   * Version-checked (and optionally fenced) state change; emits `operation.state` on
   * transitions. The store does not guard transitions, so this refuses to move a terminal
   * Operation to any other state (the version check makes `op.state` the stored state).
   */
  async update(
    op: OperationRecord,
    patch: OperationPatch,
    fence?: Fence,
  ): Promise<OperationRecord> {
    if (isTerminal(op.state) && patch.state !== undefined && patch.state !== op.state) {
      throw new StateError(
        'INVALID_TRANSITION',
        `operation '${op.id}' is ${op.state} and cannot become ${patch.state}`,
        { context: { operationId: op.id } },
      );
    }
    const next = await this.deps.stores.operations.update(
      this.deps.namespace,
      op.id,
      patch,
      op.version,
      fence,
    );
    if (next.state !== op.state) this.emitState(next, op.state);
    return next;
  }

  protected emitState(record: OperationRecord, from: OperationState | null): void {
    this.deps.events.emit('operation.state', {
      namespace: this.deps.namespace,
      operationId: record.id,
      chain: record.context.chain,
      network: record.context.network,
      from,
      to: record.state,
      ...(record.error ? { code: record.error.code } : {}),
    });
  }

  /** Repeats of failed or stalled Operations surface the same error as the original call. */
  protected settle(op: OperationRecord): OperationRecord {
    if ((op.state === 'failed' || op.state === 'stalled') && op.error) {
      throw rehydrateError(op.error, op.id);
    }
    return op;
  }
}
