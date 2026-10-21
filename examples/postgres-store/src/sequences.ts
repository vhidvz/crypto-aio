import { StateError, type SequenceState, type SequenceStore } from 'crypto-aio';
import { Db, type PostgresStoreOptions } from './db';

interface SequenceRow {
  readonly next: string;
  readonly released: string[];
  readonly fence: string;
  readonly version: string;
}

/**
 * The SequenceStore port on PostgreSQL. Values are `numeric` (an EVM nonce is a u64) and
 * cross the wire as decimal text, so no value passes through a JavaScript number.
 * Messages omit the key: it embeds a wallet address, and error messages reach logs.
 */
export class PostgresSequenceStore implements SequenceStore {
  readonly #db: Db;
  readonly #sequences: string;

  constructor(options: PostgresStoreOptions) {
    this.#db = new Db(options.pool, options);
    this.#sequences = this.#db.table('sequences');
  }

  async get(key: string): Promise<SequenceState | null> {
    const { rows } = await this.#db.query<SequenceRow>(
      `SELECT next::text, released::text[], fence::text, version
         FROM ${this.#sequences} WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      next: BigInt(row.next),
      released: row.released.map((value) => BigInt(value)),
      fence: BigInt(row.fence),
      version: Number(row.version),
    };
  }

  /**
   * Locks the row, then checks the version before the fence, as the memory store does, so
   * each refusal has its exact code; only then writes.
   */
  async put(
    key: string,
    state: Omit<SequenceState, 'version'>,
    expectedVersion: number | null,
  ): Promise<void> {
    const values = [
      key,
      state.next.toString(),
      state.released.map((value) => value.toString()),
      state.fence.toString(),
    ];
    await this.#db.transaction(async (query) => {
      const { rows } = await query<{ version: string; fence: string }>(
        `SELECT version, fence::text FROM ${this.#sequences} WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const current = rows[0];
      if ((current ? Number(current.version) : null) !== expectedVersion) {
        throw new StateError(
          'VERSION_CONFLICT',
          'the sequence was modified concurrently',
        );
      }
      if (current && state.fence < BigInt(current.fence)) {
        throw new StateError('FENCING', 'stale fencing token for the sequence');
      }
      if (current) {
        await query(
          `UPDATE ${this.#sequences}
              SET next = $2, released = $3::numeric[], fence = $4, version = version + 1
            WHERE key = $1`,
          values,
        );
        return;
      }
      // No row to lock: two first writers can both get here. The insert lets one win;
      // the other inserts nothing, as if it had read the winner's row.
      const { rowCount } = await query(
        `INSERT INTO ${this.#sequences} (key, next, released, fence, version)
         VALUES ($1, $2, $3::numeric[], $4, 1)
         ON CONFLICT (key) DO NOTHING`,
        values,
      );
      if (rowCount === 0) {
        throw new StateError(
          'VERSION_CONFLICT',
          'the sequence was modified concurrently',
        );
      }
    });
  }
}
