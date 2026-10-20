import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { parseTagged, stringifyTagged, type Clock } from 'crypto-aio';

/** Runs one statement and returns its rows. */
export type Query = <R extends QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<{ readonly rows: R[]; readonly rowCount: number }>;

export interface PostgresStoreOptions {
  /** The pool every store of this schema shares. Point it at the primary, never a replica. */
  readonly pool: Pool;
  /** The schema that holds the tables; create them with `migrate` (default `crypto_aio`). */
  readonly schema?: string;
  /**
   * The clock for `createdAt`, `updatedAt` and lease expiry: pass the container's own clock.
   * The engine compares `createdAt` with its clock, so both must keep the same time.
   * Default: `Date.now`.
   */
  readonly clock?: Pick<Clock, 'now'>;
}

/** A plain identifier, so a schema name never needs quoting inside SQL text. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function schemaName(schema: string | undefined): string {
  const name = schema ?? 'crypto_aio';
  if (!SCHEMA_NAME.test(name)) {
    throw new TypeError(
      'the schema name must be a lower-case identifier: letters, digits and underscores',
    );
  }
  return name;
}

/**
 * A database error with the row data left out. Postgres puts the values of the failing row
 * in an error's `detail` (a not-null or unique violation names every column, idempotency
 * key and address included), and a data exception (SQLSTATE class 22) quotes the value in
 * its message. Error messages reach logs, so neither is kept, and the driver's error is not
 * kept as the cause either.
 */
export class PostgresStoreError extends Error {
  override readonly name = 'PostgresStoreError';
  /** The SQLSTATE code, such as `23502`. */
  readonly sqlState: string;
  /** The table, column and constraint concerned, when Postgres names them. */
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;

  constructor(error: {
    readonly code: string;
    readonly message: string;
    readonly table?: string;
    readonly column?: string;
    readonly constraint?: string;
  }) {
    super(
      error.code.startsWith('22')
        ? `a value was refused by the database (SQLSTATE ${error.code})`
        : `${error.message} (SQLSTATE ${error.code})`,
    );
    this.sqlState = error.code;
    if (error.table !== undefined) this.table = error.table;
    if (error.column !== undefined) this.column = error.column;
    if (error.constraint !== undefined) this.constraint = error.constraint;
  }
}

/** A server-side error: it carries a five-character SQLSTATE `code`. */
function isDatabaseError(
  error: unknown,
): error is ConstructorParameters<typeof PostgresStoreError>[0] {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

function sanitized(error: unknown): unknown {
  return isDatabaseError(error) ? new PostgresStoreError(error) : error;
}

/** The connection and the conventions every store of one schema shares. */
export class Db {
  readonly schema: string;
  readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    options: Omit<PostgresStoreOptions, 'pool'> = {},
  ) {
    this.schema = schemaName(options.schema);
    const clock = options.clock;
    this.now = clock ? () => clock.now() : () => Date.now();
  }

  /** `name`, qualified with the store's schema. */
  table(name: string): string {
    return `${this.schema}.${name}`;
  }

  /** One statement, run on its own (it commits by itself). */
  readonly query: Query = (text, values) => run(this.pool, text, values);

  /**
   * Runs `fn` in one transaction, at READ COMMITTED: each statement sees what committed
   * before it began, and the row locks taken with `FOR UPDATE` make the version and fence
   * checks exact. The level is set explicitly, so a server whose default is SERIALIZABLE
   * cannot add serialization failures this code would have to retry.
   */
  async transaction<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await run(client, 'BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await fn((text, values) => run(client, text, values));
      await run(client, 'COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is unusable; destroy it rather than return it to the pool.
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

/** U+0000, or half of a surrogate pair without its other half. */
const UNSTORABLE =
  /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuses a string `text` cannot hold as it is. Postgres refuses U+0000 itself, but the
 * driver encodes a lone surrogate as U+FFFD, so two different idempotency keys would become
 * one. Both are refused before the statement, as Postgres refuses U+0000 (SQLSTATE 22021).
 * JSON text never holds either: `stringifyTagged` escapes them.
 */
function assertStorable(values: readonly unknown[] | undefined): void {
  for (const value of values ?? []) {
    if (typeof value === 'string' && UNSTORABLE.test(value)) {
      throw new PostgresStoreError({ code: '22021', message: '' });
    }
  }
}

async function run<R extends QueryResultRow>(
  target: Pool | PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<{ readonly rows: R[]; readonly rowCount: number }> {
  assertStorable(values);
  try {
    const result = await target.query<R>(text, values as unknown[] | undefined);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw sanitized(error);
  }
}

/** Tagged JSON text for a nested value, or NULL for an absent one. */
export function toJson(value: unknown): string | null {
  return value === undefined ? null : stringifyTagged(value);
}

export function fromJson<T>(text: string): T {
  return parseTagged<T>(text);
}
