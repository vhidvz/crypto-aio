import type { AssetService } from '../assets/service';
import type { LifecycleOptions, ResolvedSelection } from '../config/types';
import type { PooledDriver } from '../container/pool';
import type { BuildContext } from '../driver/types';
import {
  ChainError,
  StateError,
  ValidationError,
  createError,
  isCryptoAioError,
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
import type { UnsignedTx } from '../model/transaction';
import { reservedInputs, seqnoHolder } from '../ordering/reservations';
import {
  sequenceKey,
  type LeaseHandle,
  type SequenceCoordinator,
} from '../ordering/sequence';
import { sanitizeError } from '../secret/redact';
import type { SigningOrchestrator } from '../signing/orchestrator';
import type { SignerTicket, SigningContext, SigningPurpose } from '../signing/types';
import type { ResolvedWallet } from '../signing/wallet';
import {
  isTerminal,
  type ExecutionContext,
  type Fence,
  type OperationPatch,
  type OperationRecord,
  type OperationState,
  type Stores,
} from '../store/types';
import { randomId } from '../util/bytes';
import type { Clock } from '../util/clock';
import { canonicalJson, sha256Hex } from '../util/json';
import { normalizeIntent } from './intent';

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
};

export function withLifecycleDefaults(options: LifecycleOptions): ResolvedLifecycle {
  const out: Record<string, unknown> = { ...LIFECYCLE_DEFAULTS };
  for (const [key, value] of Object.entries(options))
    if (value !== undefined) out[key] = value;
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
  const matches =
    built.kind === kind &&
    (built.kind === 'nonce'
      ? allocated?.kind === 'nonce' && built.nonce === allocated.nonce
      : built.kind === 'seqno'
        ? allocated?.kind === 'seqno' && built.seqno === allocated.seqno
        : built.kind === 'inputs'
          ? !built.inputs.some((input) => excluded?.includes(input))
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
   * Only before any signed bytes exist. Under the address lease (R23): re-reads the
   * Operation, marks it `abandoned` and releases its reservation. Pending signer tickets are
   * cancelled after the lease is dropped, even when the release failed.
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
  ): Promise<T> {
    if (!LEASED_ORDERINGS.has(target.pooled.driver.ordering)) return fn(undefined);
    return this.deps.sequences.withLease(this.sequenceKeyOf(target), fn, signal);
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
   * Terminal failure while no valid signed bytes exist: mark failed, then free the nonce,
   * both under one address lease (R23). Callers already inside `withAddressLease` must pass
   * their lease (it is not re-entrant). A failed release is logged by code and the original
   * `error` is rethrown in its place.
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
    const failed = await this.update(op, {
      state: 'failed',
      error: serializeError(error),
      clear: ['unsigned', 'partialSignatures', 'signerTickets'],
    });
    try {
      await this.releaseReservation(target, op, lease);
    } catch (releaseError) {
      this.deps.log.warn('reservation release failed', {
        operationId: op.id,
        code: errorCode(releaseError),
      });
      throw error;
    }
    return failed;
  }

  /**
   * Returns the Operation's reserved nonce. Call at most once per allocation, only after
   * the Operation's terminal CAS, and pass the held lease when already inside one
   * (`withLease` is not re-entrant).
   */
  protected async releaseReservation(
    target: OperationTarget,
    op: OperationRecord,
    lease?: LeaseHandle,
  ): Promise<void> {
    const reservation = op.reservation;
    if (reservation?.kind !== 'nonce') return;
    const key = this.sequenceKeyOf(target);
    if (lease) {
      await this.deps.sequences.release(lease, key, reservation.nonce);
      return;
    }
    await this.deps.sequences.withLease(key, (held) =>
      this.deps.sequences.release(held, key, reservation.nonce),
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
