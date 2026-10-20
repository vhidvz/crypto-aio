/**
 * A reference implementation of crypto-aio's four store ports on PostgreSQL, proven by the
 * contract suites of `crypto-aio/testing`. Copy it into your project and adapt it; README.md
 * explains each design choice.
 *
 * ```ts
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await migrate(pool);
 * const aio = new CryptoAio({ stores: createPostgresStores({ pool }), … });
 * ```
 */
import type { Stores } from 'crypto-aio';
import type { PostgresStoreOptions } from './db';
import { PostgresCursorStore } from './cursors';
import { PostgresLockManager } from './locks';
import { PostgresOperationStore } from './operations';
import { PostgresSequenceStore } from './sequences';

export { PostgresStoreError, type PostgresStoreOptions } from './db';
export { PostgresCursorStore } from './cursors';
export { PostgresLockManager } from './locks';
export { PostgresOperationStore } from './operations';
export { PostgresSequenceStore } from './sequences';
export { SCHEMA_SQL_PATH, migrate } from './schema';

/** The four stores on one pool and schema, ready for `new CryptoAio({ stores })`. */
export function createPostgresStores(options: PostgresStoreOptions): Stores {
  return {
    operations: new PostgresOperationStore(options),
    locks: new PostgresLockManager(options),
    sequences: new PostgresSequenceStore(options),
    cursors: new PostgresCursorStore(options),
  };
}
