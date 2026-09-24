import type { AssetService } from '../assets/service';
import type { LifecycleOptions, ResolvedSelection } from '../config/types';
import type { PooledDriver } from '../container/pool';
import type { BroadcastResult, BuildContext } from '../driver/types';
import {
  ChainError,
  ConfigError,
  ProviderError,
  SigningError,
  StateError,
  TimeoutError,
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
import type { OrderingData, OrderingKind } from '../model/ordering';
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
  type AttemptRecord,
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
import { normalizeIntent } from './intent';
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
        async (lease) => {
          let fresh = await this.require(record.id);
          if (fresh.state === 'created') {
            fresh = await this.prepareStage(target, fresh, stored, lease, options.signal);
          }
          if (fresh.state === 'prepared') {
            await this.authorizeOrFail(target, fresh, lease);
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
      const done = await this.withOperationLease(target, operationId, async (lease) => {
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
   * the address lease (R23).
   */
  async rebroadcast(
    target: OperationTarget,
    operationId: string,
  ): Promise<OperationRecord> {
    return this.withAddressLease(target, async (lease) => {
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
      return this.broadcastActive(target, op, undefined, lease);
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
      return await this.withAddressLease(target, async (lease) => {
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
        await this.releaseReservation(target, op, lease);
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

  protected withAddressLease<T>(
    target: OperationTarget,
    fn: (lease: LeaseHandle | undefined) => Promise<T>,
    signal?: AbortSignal,
    options?: { readonly acquireTimeoutMs?: number },
  ): Promise<T> {
    if (!LEASED_ORDERINGS.has(target.pooled.driver.ordering)) return fn(undefined);
    return this.deps.sequences.withLease(this.sequenceKeyOf(target), fn, signal, options);
  }

  /**
   * Serializes one Operation's signing transitions: the wallet's address lease where the
   * ordering needs one, otherwise (expiry ordering) a short per-Operation lock, so two
   * same-key repeats can never both sign it (R24). Its handle is passed down (renewed,
   * heartbeat) exactly like the address lease; it never guards a sequence write.
   */
  protected withOperationLease<T>(
    target: OperationTarget,
    operationId: string,
    fn: (lease: LeaseHandle | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (LEASED_ORDERINGS.has(target.pooled.driver.ordering)) {
      return this.withAddressLease(target, fn, signal);
    }
    return this.deps.sequences.withLease(
      `op:${this.deps.namespace}:${operationId}`,
      fn,
      signal,
    );
  }

  protected sequenceKeyOf(target: OperationTarget): string {
    return sequenceKey(
      this.deps.namespace,
      target.selection.chain.id,
      target.selection.network.id,
      target.wallet.address.canonical,
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
    const key = this.sequenceKeyOf(target);
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
          reservation = {
            kind: 'seqno',
            seqno: await driver.sequence.pending(stored.from),
            validUntil: 0,
          };
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

  protected async authorizeOrFail(
    target: OperationTarget,
    op: OperationRecord,
    lease?: LeaseHandle,
  ): Promise<void> {
    try {
      await this.deps.orchestrator.authorize(
        this.signingContext(target, op, op.unsigned as UnsignedTx, 'original'),
      );
    } catch (error) {
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
      op.id,
      async (lease) => {
        let fresh = await this.require(op.id);
        if (fresh.state === 'created') {
          fresh = await this.prepareStage(target, fresh, stored, lease, signal);
        }
        if (fresh.state === 'prepared') {
          fresh = await this.signStage(target, fresh, lease, signal);
        }
        if (awaitsBroadcast(fresh)) {
          fresh = await this.broadcastActive(target, fresh, signal, lease);
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
          'the signer did not answer within lifecycle.signTimeoutMs',
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
      return next.state === 'stalled' ? error : next;
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
        await this.releaseReservation(target, current, lease);
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
      async (lease) => {
        const wallet = {
          namespace: this.deps.namespace,
          chain: op.context.chain,
          network: op.context.network,
          from: op.intent.from,
        };
        const key = this.sequenceKeyOf(target);
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
      return this.withAddressLease(target, (held) =>
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
      await this.releaseReservation(target, op, lease);
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
    target: OperationTarget,
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
    await this.deps.sequences.release(
      lease,
      this.sequenceKeyOf(target),
      reservation.nonce,
    );
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
