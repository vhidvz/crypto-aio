import type { Lease, LockManager } from 'crypto-aio';
import { Db, type PostgresStoreOptions } from './db';

interface LeaseRow {
  readonly token: string;
  readonly expires_at: number;
}

/**
 * The LockManager port on PostgreSQL: one row per key. Each method is one statement, so
 * each is atomic on its own. Lock keys embed wallet addresses, and no error here names one.
 */
export class PostgresLockManager implements LockManager {
  readonly #db: Db;
  readonly #leases: string;

  constructor(options: PostgresStoreOptions) {
    this.#db = new Db(options.pool, options);
    this.#leases = this.#db.table('leases');
  }

  /**
   * Inserts the key's first lease, or takes over a released or expired one with the next
   * token. Concurrent acquirers of one key queue on its row (the insert's conflict check
   * waits for the first to commit) and then see its lease, so exactly one wins.
   */
  async acquire(key: string, owner: string, ttlMs: number): Promise<Lease | null> {
    const now = this.#db.now();
    const { rows } = await this.#db.query<LeaseRow>(
      `INSERT INTO ${this.#leases} AS l (key, owner, token, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key) DO UPDATE
          SET owner = excluded.owner, token = l.token + 1, expires_at = excluded.expires_at
        WHERE l.owner IS NULL OR l.expires_at <= $4
       RETURNING token, expires_at`,
      [key, owner, now + ttlMs, now],
    );
    return leaseOf(key, owner, rows[0]);
  }

  /** Extends an unexpired lease that is still this holder's (same owner and token). */
  async renew(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const now = this.#db.now();
    const { rows } = await this.#db.query<LeaseRow>(
      `UPDATE ${this.#leases} SET expires_at = $4
        WHERE key = $1 AND owner = $2 AND token = $3 AND expires_at > $5
       RETURNING token, expires_at`,
      [lease.key, lease.owner, lease.token.toString(), now + ttlMs, now],
    );
    return leaseOf(lease.key, lease.owner, rows[0]);
  }

  /** Frees the lease if this holder still has it; a stale release changes nothing. */
  async release(lease: Lease): Promise<void> {
    await this.#db.query(
      `UPDATE ${this.#leases} SET owner = NULL, expires_at = 0
        WHERE key = $1 AND owner = $2 AND token = $3`,
      [lease.key, lease.owner, lease.token.toString()],
    );
  }
}

function leaseOf(key: string, owner: string, row: LeaseRow | undefined): Lease | null {
  if (!row) return null;
  return Object.freeze({
    key,
    owner,
    token: BigInt(row.token),
    expiresAt: row.expires_at,
  });
}
