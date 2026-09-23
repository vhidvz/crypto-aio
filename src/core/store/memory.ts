import { StateError } from '../errors/error';
import { systemClock, type Clock } from '../util/clock';
import { clone } from './clone';
import { CLEARABLE_FIELDS, isTerminal, OPERATION_PATCH_KEYS } from './types';
import type {
  AttemptObservation,
  AttemptRecord,
  CreateResult,
  CursorStore,
  Fence,
  Lease,
  LockManager,
  NewOperation,
  OperationFilter,
  OperationPatch,
  OperationRecord,
  OperationStore,
  ScanCursor,
  SequenceState,
  SequenceStore,
  Stores,
  StoredCursor,
} from './types';

export class MemoryLockManager implements LockManager {
  readonly #held = new Map<string, Lease>();
  readonly #tokens = new Map<string, bigint>();

  constructor(private readonly clock: Clock = systemClock) {}

  async acquire(key: string, owner: string, ttlMs: number): Promise<Lease | null> {
    const now = this.clock.now();
    const current = this.#held.get(key);
    if (current && current.expiresAt > now) return null;
    const token = (this.#tokens.get(key) ?? 0n) + 1n;
    this.#tokens.set(key, token);
    const lease: Lease = Object.freeze({ key, owner, token, expiresAt: now + ttlMs });
    this.#held.set(key, lease);
    return lease;
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const now = this.clock.now();
    const current = this.#held.get(lease.key);
    if (!current || current.token !== lease.token || current.owner !== lease.owner)
      return null;
    if (current.expiresAt <= now) return null;
    const renewed: Lease = Object.freeze({ ...current, expiresAt: now + ttlMs });
    this.#held.set(lease.key, renewed);
    return renewed;
  }

  async release(lease: Lease): Promise<void> {
    const current = this.#held.get(lease.key);
    if (current && current.token === lease.token && current.owner === lease.owner) {
      this.#held.delete(lease.key);
    }
  }
}

export class MemorySequenceStore implements SequenceStore {
  readonly #states = new Map<string, SequenceState>();

  async get(key: string): Promise<SequenceState | null> {
    const state = this.#states.get(key);
    return state ? clone(state) : null;
  }

  async put(
    key: string,
    state: Omit<SequenceState, 'version'>,
    expectedVersion: number | null,
  ): Promise<void> {
    const current = this.#states.get(key);
    if ((current?.version ?? null) !== expectedVersion) {
      throw new StateError(
        'VERSION_CONFLICT',
        `sequence '${key}' was modified concurrently`,
      );
    }
    if (current && state.fence < current.fence) {
      throw new StateError('FENCING', `stale fencing token for sequence '${key}'`);
    }
    this.#states.set(key, clone({ ...state, version: (current?.version ?? 0) + 1 }));
  }
}

export class MemoryCursorStore implements CursorStore {
  readonly #cursors = new Map<string, StoredCursor>();

  async get(key: string): Promise<StoredCursor | null> {
    const stored = this.#cursors.get(key);
    return stored ? clone(stored) : null;
  }

  async put(
    key: string,
    cursor: ScanCursor,
    expectedVersion: number | null,
  ): Promise<number> {
    const current = this.#cursors.get(key);
    if ((current?.version ?? null) !== expectedVersion) {
      throw new StateError(
        'VERSION_CONFLICT',
        `cursor '${key}' was modified concurrently`,
      );
    }
    const version = (current?.version ?? 0) + 1;
    this.#cursors.set(key, clone({ cursor, version }));
    return version;
  }
}

const compositeKey = (namespace: string, id: string): string => `${namespace}\u0000${id}`;

const OPERATION_PATCH_KEY_SET: ReadonlySet<string> = new Set(OPERATION_PATCH_KEYS);
const CLEARABLE_FIELD_SET: ReadonlySet<string> = new Set(CLEARABLE_FIELDS);

/**
 * Validates a pre-read snapshot of a patch's own keys, so a spread-typed patch (e.g.
 * `{ ...record, state }` forced through `as unknown as OperationPatch`) cannot write
 * or clear a field outside the writable whitelist — `attempts`, `claim`, `id`,
 * `namespace`, `idempotencyKey`, `intentHash`, `context`, `kind`, `version`,
 * `createdAt` and `updatedAt` are never reachable through `update`/`appendAttempt`.
 */
function assertValidPatch(
  entries: readonly (readonly [string, unknown])[],
  clearList: readonly string[],
): void {
  for (const [key] of entries) {
    if (key !== 'clear' && !OPERATION_PATCH_KEY_SET.has(key)) {
      throw new StateError('INVALID_TRANSITION', `unsupported patch field '${key}'`);
    }
  }
  for (const key of clearList) {
    if (!CLEARABLE_FIELD_SET.has(key)) {
      throw new StateError('INVALID_TRANSITION', `unsupported patch field '${key}'`);
    }
  }
}

function applyPatch(
  current: OperationRecord,
  patch: OperationPatch,
  now: number,
): OperationRecord {
  // Read the patch's own keys exactly once: the same snapshot is both validated and
  // applied, so an accessor (a getter or Proxy trap) on the patch object can't change
  // what keys are visible between validation and application.
  const entries = Object.entries(patch) as readonly (readonly [string, unknown])[];
  const clearList = (entries.find(([key]) => key === 'clear')?.[1] ??
    []) as readonly string[];
  assertValidPatch(entries, clearList);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    if (key === 'clear') continue;
    if (value !== undefined) next[key] = clone(value);
  }
  for (const key of clearList) delete next[key];
  next.version = current.version + 1;
  next.updatedAt = now;
  return next as unknown as OperationRecord;
}

function matches(record: OperationRecord, filter: OperationFilter): boolean {
  return (
    record.namespace === filter.namespace &&
    (filter.chain === undefined || record.context.chain === filter.chain) &&
    (filter.network === undefined || record.context.network === filter.network) &&
    (filter.from === undefined || record.intent.from === filter.from) &&
    (filter.states === undefined || filter.states.includes(record.state))
  );
}

export class MemoryOperationStore implements OperationStore {
  readonly #records = new Map<string, OperationRecord>();
  readonly #keys = new Map<string, string>();
  readonly #observations = new Map<string, AttemptObservation>();
  #claims = 0n;

  constructor(private readonly clock: Clock = systemClock) {}

  async create(operation: NewOperation): Promise<CreateResult> {
    for (const key of ['claim', 'version', 'createdAt', 'updatedAt']) {
      if (Object.prototype.hasOwnProperty.call(operation, key)) {
        throw new StateError(
          'INVALID_TRANSITION',
          `unsupported operation field '${key}'`,
        );
      }
    }
    const keyIndex = compositeKey(operation.namespace, operation.idempotencyKey);
    const existingId = this.#keys.get(keyIndex);
    if (existingId !== undefined) {
      return {
        created: false,
        record: clone(this.#require(operation.namespace, existingId)),
      };
    }
    const recordKey = compositeKey(operation.namespace, operation.id);
    if (this.#records.has(recordKey)) {
      throw new StateError(
        'INVALID_TRANSITION',
        `operation '${operation.id}' already exists`,
      );
    }
    const now = this.clock.now();
    const record = {
      ...clone(operation),
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as OperationRecord;
    this.#records.set(recordKey, record);
    this.#keys.set(keyIndex, operation.id);
    return { created: true, record: clone(record) };
  }

  async get(namespace: string, id: string): Promise<OperationRecord | null> {
    const record = this.#records.get(compositeKey(namespace, id));
    return record ? clone(record) : null;
  }

  async getByKey(
    namespace: string,
    idempotencyKey: string,
  ): Promise<OperationRecord | null> {
    const id = this.#keys.get(compositeKey(namespace, idempotencyKey));
    return id !== undefined ? this.get(namespace, id) : null;
  }

  async findByRef(
    namespace: string,
    refOrTxHash: string,
  ): Promise<OperationRecord | null> {
    for (const record of this.#records.values()) {
      if (
        record.namespace === namespace &&
        record.attempts.some((a) => a.ref.id === refOrTxHash)
      ) {
        return clone(record);
      }
    }
    for (const observation of this.#observations.values()) {
      if (observation.txHash !== refOrTxHash) continue;
      const record = this.#records.get(compositeKey(namespace, observation.operationId));
      // The observed attempt must actually belong to this record: two namespaces can
      // otherwise share an operation id and resolve the tx hash to the wrong operation.
      if (record && record.attempts.some((a) => a.id === observation.attemptId)) {
        return clone(record);
      }
    }
    return null;
  }

  async update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const current = this.#check(namespace, id, expectedVersion, fence);
    const next = applyPatch(current, patch, this.clock.now());
    this.#records.set(compositeKey(namespace, id), next);
    return clone(next);
  }

  async appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const current = this.#check(namespace, id, expectedVersion, fence);
    if (current.attempts.some((a) => a.id === attempt.id)) {
      throw new StateError(
        'INVALID_TRANSITION',
        `attempt '${attempt.id}' already exists`,
      );
    }
    const withAttempt: OperationRecord = {
      ...current,
      attempts: [...current.attempts, clone(attempt)],
      activeAttemptId: attempt.id,
    };
    const next = applyPatch(withAttempt, patch, this.clock.now());
    this.#records.set(compositeKey(namespace, id), next);
    return clone(next);
  }

  async getObservation(attemptId: string): Promise<AttemptObservation | null> {
    const observation = this.#observations.get(attemptId);
    return observation ? clone(observation) : null;
  }

  async putObservation(
    observation: Omit<AttemptObservation, 'version'>,
    expectedVersion: number | null,
  ): Promise<AttemptObservation> {
    const current = this.#observations.get(observation.attemptId);
    if ((current?.version ?? null) !== expectedVersion) {
      throw new StateError(
        'VERSION_CONFLICT',
        `observation '${observation.attemptId}' was modified concurrently`,
      );
    }
    const next: AttemptObservation = {
      ...clone(observation),
      version: (current?.version ?? 0) + 1,
    };
    this.#observations.set(observation.attemptId, next);
    return clone(next);
  }

  async claimDue(
    namespace: string,
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<OperationRecord[]> {
    if (limit <= 0) return [];
    const due = [...this.#records.values()]
      .filter(
        (r) =>
          r.namespace === namespace &&
          !isTerminal(r.state) &&
          r.nextCheckAt !== undefined &&
          r.nextCheckAt <= now &&
          (!r.claim || r.claim.until <= now),
      )
      .sort(
        (a, b) =>
          (a.nextCheckAt as number) - (b.nextCheckAt as number) ||
          a.createdAt - b.createdAt,
      )
      .slice(0, limit);
    return due.map((record) => {
      this.#claims += 1n;
      const next: OperationRecord = {
        ...record,
        claim: { workerId, token: this.#claims.toString(), until: now + leaseMs },
        version: record.version + 1,
        updatedAt: this.clock.now(),
      };
      this.#records.set(compositeKey(namespace, record.id), next);
      return clone(next);
    });
  }

  async releaseClaim(namespace: string, id: string, fence: Fence): Promise<void> {
    const current = this.#require(namespace, id);
    if (current.claim?.token !== fence.claimToken) {
      throw new StateError('FENCING', `claim on operation '${id}' is no longer held`);
    }
    const { claim: _claim, ...rest } = current;
    this.#records.set(compositeKey(namespace, id), {
      ...rest,
      version: current.version + 1,
      updatedAt: this.clock.now(),
    });
  }

  async list(filter: OperationFilter): Promise<OperationRecord[]> {
    const found = [...this.#records.values()]
      .filter((r) => matches(r, filter))
      .sort((a, b) => a.createdAt - b.createdAt);
    return clone(filter.limit === undefined ? found : found.slice(0, filter.limit));
  }

  async purge(filter: OperationFilter): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (!matches(record, filter)) continue;
      this.#records.delete(key);
      this.#keys.delete(compositeKey(record.namespace, record.idempotencyKey));
      for (const attempt of record.attempts) this.#observations.delete(attempt.id);
      removed += 1;
    }
    return removed;
  }

  #require(namespace: string, id: string): OperationRecord {
    const record = this.#records.get(compositeKey(namespace, id));
    if (!record) throw new StateError('NOT_FOUND', `operation '${id}' not found`);
    return record;
  }

  #check(
    namespace: string,
    id: string,
    expectedVersion: number,
    fence?: Fence,
  ): OperationRecord {
    const record = this.#require(namespace, id);
    if (record.version !== expectedVersion) {
      throw new StateError(
        'VERSION_CONFLICT',
        `operation '${id}' was modified concurrently (expected v${expectedVersion}, found v${record.version})`,
      );
    }
    if (fence && record.claim?.token !== fence.claimToken) {
      throw new StateError('FENCING', `claim on operation '${id}' is no longer held`);
    }
    return record;
  }
}

export function createMemoryStores(clock: Clock = systemClock): Stores {
  return {
    operations: new MemoryOperationStore(clock),
    locks: new MemoryLockManager(clock),
    sequences: new MemorySequenceStore(),
    cursors: new MemoryCursorStore(),
  };
}
