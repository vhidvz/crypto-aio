import { StateError } from '../errors/error';
import { systemClock, type Clock } from '../util/clock';
import { clone } from './clone';
import type {
  CursorStore,
  Lease,
  LockManager,
  ScanCursor,
  SequenceState,
  SequenceStore,
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
