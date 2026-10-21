import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { schemaName } from './db';

/** schema.sql, next to this directory. */
export const SCHEMA_SQL_PATH = join(__dirname, '..', 'schema.sql');

/**
 * Creates the schema and its tables (schema.sql) if they do not exist yet. Safe to run on
 * every start: processes that start together take turns on an advisory lock, and every
 * statement is `IF NOT EXISTS`. A deployment with its own migration tool can run
 * schema.sql there instead.
 */
export async function migrate(pool: Pool, schema?: string): Promise<void> {
  const name = schemaName(schema);
  const sql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `crypto-aio:${name}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);
    // SET LOCAL: only for this transaction, so the pooled connection is left as it was.
    await client.query(`SET LOCAL search_path TO ${name}`);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
