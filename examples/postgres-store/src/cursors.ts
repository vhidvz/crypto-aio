import {
  StateError,
  stringifyTagged,
  type CursorStore,
  type ScanCursor,
  type StoredCursor,
} from 'crypto-aio';
import { Db, fromJson, type PostgresStoreOptions } from './db';

/**
 * The CursorStore port on PostgreSQL: one row per scanner key, its cursor as tagged JSON.
 * Each put is one compare-and-set statement. Messages omit the key: it can name a watched
 * wallet, and error messages reach logs.
 */
export class PostgresCursorStore implements CursorStore {
  readonly #db: Db;
  readonly #cursors: string;

  constructor(options: PostgresStoreOptions) {
    this.#db = new Db(options.pool, options);
    this.#cursors = this.#db.table('cursors');
  }

  async get(key: string): Promise<StoredCursor | null> {
    const { rows } = await this.#db.query<{ cursor: string; version: string }>(
      `SELECT cursor, version FROM ${this.#cursors} WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return { cursor: fromJson<ScanCursor>(row.cursor), version: Number(row.version) };
  }

  async put(
    key: string,
    cursor: ScanCursor,
    expectedVersion: number | null,
  ): Promise<number> {
    const text = stringifyTagged(cursor);
    const { rows } =
      expectedVersion === null
        ? await this.#db.query<{ version: string }>(
            `INSERT INTO ${this.#cursors} (key, cursor, version) VALUES ($1, $2, 1)
             ON CONFLICT (key) DO NOTHING
             RETURNING version`,
            [key, text],
          )
        : await this.#db.query<{ version: string }>(
            `UPDATE ${this.#cursors} SET cursor = $2, version = version + 1
              WHERE key = $1 AND version = $3
             RETURNING version`,
            [key, text, expectedVersion],
          );
    const row = rows[0];
    if (!row) {
      throw new StateError('VERSION_CONFLICT', 'the cursor was modified concurrently');
    }
    return Number(row.version);
  }
}
