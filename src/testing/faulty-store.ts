import type {
  AttemptObservation,
  AttemptRecord,
  CreateResult,
  Fence,
  NewOperation,
  OperationFilter,
  OperationPatch,
  OperationRecord,
  OperationStore,
} from '../core/store/types';

export class CrashError extends Error {
  constructor() {
    super('injected crash');
    this.name = 'CrashError';
  }
}

export interface FaultPoint {
  readonly method: 'create' | 'update' | 'appendAttempt' | 'putObservation';
  /** Receives the method arguments; defaults to "always". */
  readonly when?: (args: readonly unknown[]) => boolean;
  /** `before`: the write never happens. `after`: the write happens, then the process "dies". */
  readonly timing: 'before' | 'after';
}

/** Wraps a store and throws `CrashError` at chosen write boundaries (one-shot faults). */
export class FaultyOperationStore implements OperationStore {
  readonly #faults: FaultPoint[] = [];

  constructor(private readonly inner: OperationStore) {}

  crashOn(fault: FaultPoint): void {
    this.#faults.push(fault);
  }

  create(operation: NewOperation): Promise<CreateResult> {
    return this.#guard('create', [operation], () => this.inner.create(operation));
  }

  get(namespace: string, id: string): Promise<OperationRecord | null> {
    return this.inner.get(namespace, id);
  }

  getByKey(namespace: string, key: string): Promise<OperationRecord | null> {
    return this.inner.getByKey(namespace, key);
  }

  findByRef(namespace: string, ref: string): Promise<OperationRecord | null> {
    return this.inner.findByRef(namespace, ref);
  }

  update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    return this.#guard('update', [namespace, id, patch, expectedVersion], () =>
      this.inner.update(namespace, id, patch, expectedVersion, fence),
    );
  }

  appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    return this.#guard('appendAttempt', [namespace, id, attempt, patch], () =>
      this.inner.appendAttempt(namespace, id, attempt, patch, expectedVersion, fence),
    );
  }

  getObservation(attemptId: string): Promise<AttemptObservation | null> {
    return this.inner.getObservation(attemptId);
  }

  putObservation(
    observation: Omit<AttemptObservation, 'version'>,
    expectedVersion: number | null,
  ): Promise<AttemptObservation> {
    return this.#guard('putObservation', [observation], () =>
      this.inner.putObservation(observation, expectedVersion),
    );
  }

  claimDue(
    namespace: string,
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<OperationRecord[]> {
    return this.inner.claimDue(namespace, workerId, now, leaseMs, limit);
  }

  releaseClaim(namespace: string, id: string, fence: Fence): Promise<void> {
    return this.inner.releaseClaim(namespace, id, fence);
  }

  list(filter: OperationFilter): Promise<OperationRecord[]> {
    return this.inner.list(filter);
  }

  async #guard<T>(
    method: FaultPoint['method'],
    args: readonly unknown[],
    run: () => Promise<T>,
  ): Promise<T> {
    const index = this.#faults.findIndex(
      (f) => f.method === method && (f.when?.(args) ?? true),
    );
    if (index < 0) return run();
    const [fault] = this.#faults.splice(index, 1);
    if (fault?.timing === 'before') throw new CrashError();
    await run();
    throw new CrashError();
  }
}
