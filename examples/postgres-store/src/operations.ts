import {
  CLEARABLE_FIELDS,
  OPERATION_PATCH_KEYS,
  StateError,
  TERMINAL_STATES,
  parseTagged,
  stringifyTagged,
  type AttemptObservation,
  type AttemptRecord,
  type ClearableField,
  type CreateResult,
  type Fence,
  type NewOperation,
  type OperationFilter,
  type OperationPatch,
  type OperationRecord,
  type OperationStore,
} from 'crypto-aio';
import { Db, fromJson, toJson, type PostgresStoreOptions, type Query } from './db';

/** How a field is kept in its column: as is, or as tagged JSON text. */
type Codec = 'value' | 'json';

/** The fields the store owns and keeps in columns of its own (or in `attempts`). */
type StoreOwned = 'attempts' | 'version' | 'claim' | 'createdAt' | 'updatedAt';

type DataField = Exclude<keyof OperationRecord, StoreOwned>;

/**
 * The column of every OperationRecord field the caller writes. The type lists each field of
 * the port's OperationRecord, so a field the port gains fails this file's typecheck until it
 * has a column here and in schema.sql.
 */
const COLUMNS: { readonly [K in DataField]-?: readonly [column: string, codec: Codec] } =
  {
    id: ['id', 'value'],
    format: ['format', 'value'],
    namespace: ['namespace', 'value'],
    idempotencyKey: ['idempotency_key', 'value'],
    intentHash: ['intent_hash', 'value'],
    context: ['context', 'json'],
    kind: ['kind', 'value'],
    state: ['state', 'value'],
    outcome: ['outcome', 'value'],
    intent: ['intent', 'json'],
    unsigned: ['unsigned', 'json'],
    reservation: ['reservation', 'json'],
    signerTickets: ['signer_tickets', 'json'],
    partialSignatures: ['partial_signatures', 'json'],
    activeAttemptId: ['active_attempt_id', 'value'],
    ambiguous: ['ambiguous', 'value'],
    error: ['error', 'json'],
    nextCheckAt: ['next_check_at', 'value'],
  };

const STORE_OWNED_INPUT = ['claim', 'version', 'createdAt', 'updatedAt'] as const;
const WRITABLE: ReadonlySet<string> = new Set(OPERATION_PATCH_KEYS);
const CLEARABLE: ReadonlySet<string> = new Set(CLEARABLE_FIELDS);

/** TERMINAL_STATES as SQL: the same list as the `operations_due` index in schema.sql. */
const TERMINAL_SQL = TERMINAL_STATES.map((state) => `'${state}'`).join(', ');

function encode(codec: Codec, value: unknown): unknown {
  if (value === undefined) return null;
  return codec === 'json' ? toJson(value) : value;
}

const unsupported = (field: string): StateError =>
  new StateError('INVALID_TRANSITION', `unsupported patch field '${field}'`);

/**
 * The columns a patch writes, from one read of its own keys, so that what is validated is
 * what is written, even for a patch with getters or a Proxy. A key outside
 * OPERATION_PATCH_KEYS, or a `clear` that is not an array of CLEARABLE_FIELDS, refuses the
 * whole patch before any statement runs. An `undefined` value writes nothing (the stored
 * value stays); `clear` writes NULL, after the values, starting from `base`.
 */
function patchColumns(
  patch: OperationPatch,
  base: ReadonlyMap<string, unknown> = new Map(),
): Map<string, unknown> {
  const entries = Object.entries(patch);
  const clear = entries.find(([key]) => key === 'clear')?.[1];
  // Only an array is a list: a number, an object or a Set is refused, never read as [].
  if (clear !== undefined && !Array.isArray(clear)) throw unsupported('clear');
  const clearList: readonly unknown[] = clear === undefined ? [] : Array.from(clear);
  for (const [key] of entries) {
    if (key !== 'clear' && !WRITABLE.has(key)) throw unsupported(key);
  }
  for (const key of clearList) {
    if (typeof key !== 'string' || !CLEARABLE.has(key)) throw unsupported(String(key));
  }
  const columns = new Map(base);
  for (const [key, value] of entries) {
    if (key === 'clear' || value === undefined) continue;
    const [column, codec] = COLUMNS[key as DataField];
    columns.set(column, encode(codec, value));
  }
  for (const key of clearList) columns.set(COLUMNS[key as ClearableField][0], null);
  return columns;
}

/** An operations row, with its Attempts' records joined by commas (`attempts`). */
type OperationRow = Readonly<Record<string, unknown>> & {
  readonly version: string;
  readonly claim_worker: string | null;
  readonly claim_token: string | null;
  readonly claim_until: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly extra: string | null;
  readonly attempts: string | null;
};

/** The record a row holds. A NULL column is an absent field: its key is left out. */
function toRecord(row: OperationRow): OperationRecord {
  const record: Record<string, unknown> =
    row.extra === null ? {} : fromJson<Record<string, unknown>>(row.extra);
  for (const [field, [column, codec]] of Object.entries(COLUMNS)) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    record[field] = codec === 'json' ? fromJson(value as string) : value;
  }
  record.attempts = fromJson<AttemptRecord[]>(`[${row.attempts ?? ''}]`);
  record.version = Number(row.version);
  if (row.claim_token !== null) {
    record.claim = {
      workerId: row.claim_worker,
      token: row.claim_token,
      until: row.claim_until,
    };
  }
  record.createdAt = row.created_at;
  record.updatedAt = row.updated_at;
  return record as unknown as OperationRecord;
}

/** The OperationStore port on PostgreSQL. Read README.md for the design. */
export class PostgresOperationStore implements OperationStore {
  readonly #db: Db;
  readonly #operations: string;
  readonly #attempts: string;
  readonly #observations: string;
  readonly #claimTokens: string;
  /**
   * The Operation `o` with its Attempts in order, all read by one statement, so from one
   * snapshot: a record never pairs a version with another version's Attempts.
   */
  readonly #record: string;

  constructor(options: PostgresStoreOptions) {
    this.#db = new Db(options.pool, options);
    this.#operations = this.#db.table('operations');
    this.#attempts = this.#db.table('attempts');
    this.#observations = this.#db.table('observations');
    this.#claimTokens = this.#db.table('claim_tokens');
    this.#record = `o.*, (SELECT string_agg(a.record, ',' ORDER BY a.position)
        FROM ${this.#attempts} a
       WHERE a.namespace = o.namespace AND a.operation_id = o.id) AS attempts`;
  }

  async create(operation: NewOperation): Promise<CreateResult> {
    for (const key of STORE_OWNED_INPUT) {
      if (Object.hasOwn(operation, key)) {
        throw new StateError(
          'INVALID_TRANSITION',
          `unsupported operation field '${key}'`,
        );
      }
    }
    // One read of the caller's object: what is stored is what was read.
    const fields = new Map(Object.entries(operation));
    const columns = new Map<string, unknown>();
    const extra: [string, unknown][] = [];
    for (const [key, value] of fields) {
      if (key === 'attempts') continue;
      if (Object.hasOwn(COLUMNS, key)) {
        const [column, codec] = COLUMNS[key as DataField];
        columns.set(column, encode(codec, value));
      } else if (value !== undefined) {
        extra.push([key, value]);
      }
    }
    const context = fields.get('context') as
      Readonly<Record<string, unknown>> | undefined;
    const intent = fields.get('intent') as Readonly<Record<string, unknown>> | undefined;
    const now = this.#db.now();
    columns
      .set('chain', context?.chain ?? null)
      .set('network', context?.network ?? null)
      .set('from_address', intent?.from ?? null)
      .set('version', 1)
      .set('created_at', now)
      .set('updated_at', now)
      .set('extra', extra.length > 0 ? stringifyTagged(Object.fromEntries(extra)) : null);
    const given = fields.get('attempts');
    const attempts = (Array.isArray(given) ? given : []).map((attempt) =>
      stringifyTagged(attempt),
    );
    const namespace = fields.get('namespace');
    const id = fields.get('id');
    const names = [...columns.keys()];

    return this.#db.transaction(async (query) => {
      const inserted = await query<OperationRow>(
        `INSERT INTO ${this.#operations} (${names.join(', ')})
         VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [...columns.values()],
      );
      const row = inserted.rows[0];
      if (row) {
        // The engine creates Operations with no Attempts; any given are stored in order.
        for (const [position, record] of attempts.entries()) {
          if (!(await this.#insertAttempt(query, namespace, id, position, record))) {
            throw new StateError('INVALID_TRANSITION', 'an attempt id repeats');
          }
        }
        return {
          created: true,
          record: toRecord({ ...row, attempts: attempts.join(',') }),
        };
      }
      // Create-if-absent: a conflict on the idempotency key returns the stored record
      // unchanged (the engine, not the store, compares intent hashes). An insert that
      // conflicted waited for the other transaction to commit, so this read sees it.
      const existing = await query<OperationRow>(
        `SELECT ${this.#record} FROM ${this.#operations} o
          WHERE o.namespace = $1 AND o.idempotency_key = $2`,
        [namespace, fields.get('idempotencyKey')],
      );
      const found = existing.rows[0];
      if (found) return { created: false, record: toRecord(found) };
      throw new StateError(
        'INVALID_TRANSITION',
        `operation '${String(id)}' already exists`,
      );
    });
  }

  async get(namespace: string, id: string): Promise<OperationRecord | null> {
    const { rows } = await this.#db.query<OperationRow>(
      `SELECT ${this.#record} FROM ${this.#operations} o
        WHERE o.namespace = $1 AND o.id = $2`,
      [namespace, id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getByKey(
    namespace: string,
    idempotencyKey: string,
  ): Promise<OperationRecord | null> {
    const { rows } = await this.#db.query<OperationRow>(
      `SELECT ${this.#record} FROM ${this.#operations} o
        WHERE o.namespace = $1 AND o.idempotency_key = $2`,
      [namespace, idempotencyKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * By an Attempt's ref first, then by an observed tx hash whose Attempt belongs to the
   * Operation. Every read goes to the pool's server, the primary, so it sees every
   * `appendAttempt` committed before it.
   */
  async findByRef(
    namespace: string,
    refOrTxHash: string,
  ): Promise<OperationRecord | null> {
    const { rows } = await this.#db.query<OperationRow>(
      `SELECT ${this.#record}
         FROM (SELECT a.operation_id, 0 AS rank
                 FROM ${this.#attempts} a
                WHERE a.namespace = $1 AND a.ref_id = $2
               UNION ALL
               SELECT b.operation_id, 1
                 FROM ${this.#observations} b
                 JOIN ${this.#attempts} a
                   ON a.namespace = $1 AND a.operation_id = b.operation_id
                  AND a.id = b.attempt_id
                WHERE b.tx_hash = $2) m
         JOIN ${this.#operations} o ON o.namespace = $1 AND o.id = m.operation_id
        ORDER BY m.rank, o.created_at, o.seq
        LIMIT 1`,
      [namespace, refOrTxHash],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    const columns = patchColumns(patch);
    return this.#db.transaction(async (query) => {
      await this.#lock(query, namespace, id, expectedVersion, fence);
      return this.#write(query, namespace, id, columns);
    });
  }

  async appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord> {
    // Serialized once: the stored Attempt is this text, whatever the caller changes later.
    const record = stringifyTagged(attempt);
    const attemptId = parseTagged<AttemptRecord>(record).id;
    // As memory: the new Attempt becomes the active one, unless the patch says otherwise.
    const columns = patchColumns(patch, new Map([['active_attempt_id', attemptId]]));
    return this.#db.transaction(async (query) => {
      await this.#lock(query, namespace, id, expectedVersion, fence);
      // The Operation row is locked, so no other append can take this position.
      const appended = await this.#insertAttempt(query, namespace, id, null, record);
      if (!appended) {
        throw new StateError(
          'INVALID_TRANSITION',
          `attempt '${attemptId}' already exists`,
        );
      }
      return this.#write(query, namespace, id, columns);
    });
  }

  async getObservation(attemptId: string): Promise<AttemptObservation | null> {
    const { rows } = await this.#db.query<{ record: string; version: string }>(
      `SELECT record, version FROM ${this.#observations} WHERE attempt_id = $1`,
      [attemptId],
    );
    const row = rows[0];
    if (!row) return null;
    const observation = fromJson<Omit<AttemptObservation, 'version'>>(row.record);
    return { ...observation, version: Number(row.version) };
  }

  /**
   * Replaces the observation whole: the row's `record` is the new observation's JSON,
   * never a merge with the old one. JSON leaves out a key whose value is `undefined`, so a
   * field the core cleared reads back `undefined`, never null.
   */
  async putObservation(
    observation: Omit<AttemptObservation, 'version'>,
    expectedVersion: number | null,
  ): Promise<AttemptObservation> {
    const { version: _version, ...fields } = observation as AttemptObservation;
    const record = stringifyTagged(fields);
    const stored = parseTagged<Omit<AttemptObservation, 'version'>>(record);
    const values = [stored.attemptId, stored.operationId, stored.txHash ?? null, record];
    const { rows } =
      expectedVersion === null
        ? await this.#db.query<{ version: string }>(
            `INSERT INTO ${this.#observations}
                    (attempt_id, operation_id, tx_hash, record, version)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (attempt_id) DO NOTHING
             RETURNING version`,
            values,
          )
        : await this.#db.query<{ version: string }>(
            `UPDATE ${this.#observations}
                SET operation_id = $2, tx_hash = $3, record = $4, version = version + 1
              WHERE attempt_id = $1 AND version = $5
             RETURNING version`,
            [...values, expectedVersion],
          );
    const row = rows[0];
    if (!row) {
      throw new StateError(
        'VERSION_CONFLICT',
        `observation '${stored.attemptId}' was modified concurrently`,
      );
    }
    return { ...stored, version: Number(row.version) };
  }

  /**
   * Claims in one statement: `FOR UPDATE SKIP LOCKED` passes over the rows another
   * claimDue holds, so concurrent workers take disjoint sets without waiting on each
   * other, and each claim draws a fresh token from the `claim_tokens` sequence.
   */
  async claimDue(
    namespace: string,
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<OperationRecord[]> {
    const count = Math.floor(limit);
    if (!(count > 0)) return [];
    return this.#db.transaction(async (query) => {
      const claimed = await query<{ id: string }>(
        `WITH due AS (
           SELECT namespace, id FROM ${this.#operations}
            WHERE namespace = $1
              AND next_check_at IS NOT NULL AND next_check_at <= $2
              AND state NOT IN (${TERMINAL_SQL})
              AND (claim_until IS NULL OR claim_until <= $2)
            ORDER BY next_check_at, created_at, seq
            LIMIT $3
              FOR UPDATE SKIP LOCKED)
         UPDATE ${this.#operations} o
            SET claim_worker = $4, claim_token = nextval('${this.#claimTokens}'),
                claim_until = $5, version = o.version + 1, updated_at = $6
           FROM due
          WHERE o.namespace = due.namespace AND o.id = due.id
         RETURNING o.id`,
        [namespace, now, count, workerId, now + leaseMs, this.#db.now()],
      );
      if (claimed.rowCount === 0) return [];
      // A second statement, so a fresh snapshot: the claimed rows are locked by this
      // transaction, and every Attempt appended to them before the lock is visible.
      const { rows } = await query<OperationRow>(
        `SELECT ${this.#record} FROM ${this.#operations} o
          WHERE o.namespace = $1 AND o.id = ANY($2::text[])
          ORDER BY o.next_check_at, o.created_at, o.seq`,
        [namespace, claimed.rows.map((row) => row.id)],
      );
      return rows.map(toRecord);
    });
  }

  async releaseClaim(namespace: string, id: string, fence: Fence): Promise<void> {
    await this.#db.transaction(async (query) => {
      const { rows } = await query<{ claim_token: string | null }>(
        `SELECT claim_token FROM ${this.#operations}
          WHERE namespace = $1 AND id = $2 FOR UPDATE`,
        [namespace, id],
      );
      const row = rows[0];
      if (!row) throw new StateError('NOT_FOUND', `operation '${id}' not found`);
      if (row.claim_token !== fence.claimToken) {
        throw new StateError('FENCING', `claim on operation '${id}' is no longer held`);
      }
      await query(
        `UPDATE ${this.#operations}
            SET claim_worker = NULL, claim_token = NULL, claim_until = NULL,
                version = version + 1, updated_at = $3
          WHERE namespace = $1 AND id = $2`,
        [namespace, id, this.#db.now()],
      );
    });
  }

  async list(filter: OperationFilter): Promise<OperationRecord[]> {
    const { where, values } = matching(filter);
    const { rows } = await this.#db.query<OperationRow>(
      `SELECT ${this.#record} FROM ${this.#operations} o
        WHERE ${where}
        ORDER BY o.created_at, o.seq
        LIMIT $${values.length}`,
      values,
    );
    return rows.map(toRecord);
  }

  /**
   * Removes what `list` would return, at most `limit` records and the oldest first, in one
   * statement: the Operations, their Attempts (by the foreign key's cascade), their
   * observations, and so their idempotency keys.
   */
  async purge(filter: OperationFilter): Promise<number> {
    const { where, values } = matching(filter);
    const { rows } = await this.#db.query<{ removed: number }>(
      `WITH doomed AS (
         SELECT o.namespace, o.id FROM ${this.#operations} o
          WHERE ${where}
          ORDER BY o.created_at, o.seq
          LIMIT $${values.length}
            FOR UPDATE),
       observed AS (
         DELETE FROM ${this.#observations} b
          USING ${this.#attempts} a, doomed d
          WHERE a.namespace = d.namespace AND a.operation_id = d.id
            AND b.attempt_id = a.id),
       removed AS (
         DELETE FROM ${this.#operations} o
          USING doomed d
          WHERE o.namespace = d.namespace AND o.id = d.id
         RETURNING 1)
       SELECT count(*)::integer AS removed FROM removed`,
      values,
    );
    return rows[0]?.removed ?? 0;
  }

  /**
   * Locks the Operation row for the rest of the transaction, then checks it as the memory
   * store does: missing (NOT_FOUND), another version (VERSION_CONFLICT), another claim
   * (FENCING). Under the lock no other write can land before this transaction's own.
   */
  async #lock(
    query: Query,
    namespace: string,
    id: string,
    expectedVersion: number,
    fence: Fence | undefined,
  ): Promise<void> {
    const { rows } = await query<{ version: string; claim_token: string | null }>(
      `SELECT version, claim_token FROM ${this.#operations}
        WHERE namespace = $1 AND id = $2 FOR UPDATE`,
      [namespace, id],
    );
    const row = rows[0];
    if (!row) throw new StateError('NOT_FOUND', `operation '${id}' not found`);
    const version = Number(row.version);
    if (version !== expectedVersion) {
      throw new StateError(
        'VERSION_CONFLICT',
        `operation '${id}' was modified concurrently (expected v${expectedVersion}, found v${version})`,
      );
    }
    if (fence && row.claim_token !== fence.claimToken) {
      throw new StateError('FENCING', `claim on operation '${id}' is no longer held`);
    }
  }

  /**
   * Writes `columns` to the locked row and bumps its version, even when nothing else
   * changes (the engine fences a stale writer with such a no-effect write), then reads the
   * record back. This statement starts after the lock was taken, so its snapshot holds
   * every Attempt of the row, this transaction's own included.
   */
  async #write(
    query: Query,
    namespace: string,
    id: string,
    columns: ReadonlyMap<string, unknown>,
  ): Promise<OperationRecord> {
    const values: unknown[] = [namespace, id, this.#db.now()];
    const sets = ['version = o.version + 1', 'updated_at = $3'];
    for (const [column, value] of columns) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    const { rows } = await query<OperationRow>(
      `WITH written AS (
         UPDATE ${this.#operations} o SET ${sets.join(', ')}
          WHERE o.namespace = $1 AND o.id = $2
         RETURNING o.*)
       SELECT ${this.#record} FROM written o`,
      values,
    );
    return toRecord(rows[0] as OperationRow);
  }

  /**
   * Inserts one Attempt at `position`, or after the last one (null). A duplicate Attempt
   * id in the same Operation inserts nothing and returns false.
   */
  async #insertAttempt(
    query: Query,
    namespace: unknown,
    operationId: unknown,
    position: number | null,
    record: string,
  ): Promise<boolean> {
    const attempt = parseTagged<Partial<AttemptRecord>>(record);
    const { rowCount } = await query(
      `INSERT INTO ${this.#attempts}
              (namespace, operation_id, position, id, ref_id, record)
       SELECT $1, $2, coalesce($3, count(*)), $4, $5, $6
         FROM ${this.#attempts} WHERE namespace = $1 AND operation_id = $2
       ON CONFLICT (namespace, operation_id, id) DO NOTHING`,
      [namespace, operationId, position, attempt.id, attempt.ref?.id ?? null, record],
    );
    return rowCount === 1;
  }
}

/**
 * The WHERE clause of a filter, as `list` and `purge` share it, with the LIMIT as the last
 * value (NULL: no limit). A limit below zero is zero.
 */
function matching(filter: OperationFilter): {
  readonly where: string;
  readonly values: readonly unknown[];
} {
  const values: unknown[] = [filter.namespace];
  const where = ['o.namespace = $1'];
  for (const [column, value] of [
    ['chain', filter.chain],
    ['network', filter.network],
    ['from_address', filter.from],
  ] as const) {
    if (value === undefined) continue;
    values.push(value);
    where.push(`o.${column} = $${values.length}`);
  }
  if (filter.states !== undefined) {
    values.push([...filter.states]);
    where.push(`o.state = ANY($${values.length}::text[])`);
  }
  values.push(filter.limit === undefined ? null : Math.max(0, Math.floor(filter.limit)));
  return { where: where.join(' AND '), values };
}
