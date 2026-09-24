import { StateError } from '../errors/error';
import type { Lease, LockManager, SequenceStore } from '../store/types';
import type { Clock } from '../util/clock';

export function sequenceKey(
  namespace: string,
  chain: string,
  network: string,
  address: string,
): string {
  return `seq:${namespace}:${chain}:${network}:${address}`;
}

const byValue = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** A held lease that can be renewed; renewal failure means another worker took over. */
export class LeaseHandle {
  #lease: Lease;

  constructor(
    private readonly locks: LockManager,
    private readonly ttlMs: number,
    lease: Lease,
  ) {
    this.#lease = lease;
  }

  get current(): Lease {
    return this.#lease;
  }

  async renew(): Promise<void> {
    const renewed = await this.locks.renew(this.#lease, this.ttlMs);
    if (!renewed)
      throw new StateError('FENCING', 'the address lease was lost to another worker');
    this.#lease = renewed;
  }
}

/**
 * Lease tokens increase per key only, so a lease for another key cannot fence this one.
 * Messages omit the key: it embeds the wallet address, and error messages reach logs.
 */
function fenceFor(lease: LeaseHandle, key: string): bigint {
  const { key: leased, token } = lease.current;
  if (leased !== key) {
    throw new StateError(
      'FENCING',
      'a lease for another address cannot write this sequence',
    );
  }
  return token;
}

export interface SequenceCoordinatorDeps {
  readonly locks: LockManager;
  readonly sequences: SequenceStore;
  readonly clock: Clock;
  readonly owner: string;
  readonly leaseMs: number;
  /** How long to wait for a busy address before failing with SEQUENCE_BUSY (default: leaseMs). */
  readonly acquireTimeoutMs?: number;
}

export class SequenceCoordinator {
  constructor(private readonly deps: SequenceCoordinatorDeps) {}

  async withLease<T>(
    key: string,
    fn: (lease: LeaseHandle) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline =
      this.deps.clock.now() + (this.deps.acquireTimeoutMs ?? this.deps.leaseMs);
    let lease = await this.deps.locks.acquire(key, this.deps.owner, this.deps.leaseMs);
    while (!lease) {
      if (this.deps.clock.now() >= deadline) {
        throw new StateError(
          'SEQUENCE_BUSY',
          'the address lease is held by another operation',
          { retryable: true },
        );
      }
      await this.deps.clock.sleep(25, signal);
      lease = await this.deps.locks.acquire(key, this.deps.owner, this.deps.leaseMs);
    }
    const handle = new LeaseHandle(this.deps.locks, this.deps.leaseMs, lease);
    try {
      return await fn(handle);
    } finally {
      // Best effort: a failed release must not replace the callback's outcome (for
      // example a completed broadcast). The lease then lapses by its TTL, and fencing
      // still guards every write.
      await this.deps.locks.release(handle.current).catch(() => undefined);
    }
  }

  async allocate(lease: LeaseHandle, key: string, chainPending: bigint): Promise<bigint> {
    const fence = fenceFor(lease, key);
    const state = await this.deps.sequences.get(key);
    const released = [...(state?.released ?? [])]
      .filter((n) => n >= chainPending)
      .sort(byValue);
    const floor = state && state.next > chainPending ? state.next : chainPending;
    const pick = released[0] ?? floor;
    const next = pick >= floor ? pick + 1n : floor;
    await this.deps.sequences.put(
      key,
      { next, released: released.filter((n) => n !== pick), fence },
      state?.version ?? null,
    );
    return pick;
  }

  /** Returns a reserved value for reuse. Only legal while no valid signed bytes exist for it. */
  async release(lease: LeaseHandle, key: string, value: bigint): Promise<void> {
    const fence = fenceFor(lease, key);
    const state = await this.deps.sequences.get(key);
    if (!state || value >= state.next || state.released.includes(value)) return;
    await this.deps.sequences.put(
      key,
      { next: state.next, released: [...state.released, value].sort(byValue), fence },
      state.version,
    );
  }
}
