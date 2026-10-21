// The PostgreSQL reference store (examples/postgres-store): the four contract suites of
// `crypto-aio/testing` against a real server, a few checks of its own design choices, and the
// engine end to end on it. Opt-in: it runs when CRYPTO_AIO_PG_URL names a database it may
// create schemas in (one per test, all dropped at the end), and is skipped otherwise.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  OPERATION_FORMAT,
  TERMINAL_STATES,
  callbackSigner,
  localSigner,
  type Clock,
  type NewOperation,
  type Signer,
} from 'crypto-aio';
import {
  CrashError,
  FakeClock,
  FaultyOperationStore,
  createFakeEnv,
  describeCursorStoreContract,
  describeLockManagerContract,
  describeOperationStoreContract,
  describeSequenceStoreContract,
  sampleAttempt,
  sampleOperation,
  type FakeEnv,
} from 'crypto-aio/testing';
import {
  PostgresStoreError,
  SCHEMA_SQL_PATH,
  createPostgresStores,
  migrate,
} from '../../examples/postgres-store/src';

const url = process.env.CRYPTO_AIO_PG_URL;
const describePg = url ? describe : describe.skip;
const api = { describe, it };

/** Schemas of this run: its own prefix, so runs sharing a server never meet. */
const prefix = `crypto_aio_test_${randomBytes(4).toString('hex')}`;
let pool: Pool;
let schemas = 0;

async function freshSchema(): Promise<string> {
  schemas += 1;
  const schema = `${prefix}_${schemas}`;
  await migrate(pool, schema);
  return schema;
}

/** The four stores on a fresh, empty schema, on a fake clock that `advance` moves. */
async function fresh() {
  const clock = new FakeClock();
  const stores = createPostgresStores({ pool, schema: await freshSchema(), clock });
  return { ...stores, advance: (ms: number) => clock.advance(ms) };
}

/** A local signer that counts its signing calls. */
function countingSigner(): { signer: Signer; calls: () => number } {
  const inner = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  let calls = 0;
  const signer = callbackSigner({
    id: 'hot',
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  });
  return { signer, calls: () => calls };
}

/**
 * Moves fake time forward until `promise` settles, but only while no query is in flight:
 * fake time stands still while Postgres works, as if it answered at once, so no lease,
 * claim or timeout runs out during a real round trip. With `mine`, a block per step.
 */
async function drive<T>(
  env: FakeEnv,
  promise: Promise<T>,
  options: { readonly stepMs?: number; readonly mine?: boolean } = {},
): Promise<T> {
  const { stepMs = 100, mine = false } = options;
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  for (let elapsed = 0; !settled;) {
    if (pool.totalCount - pool.idleCount + pool.waitingCount > 0) {
      await sleep(1);
      continue;
    }
    if (elapsed >= 600_000)
      throw new Error(`still pending after ${elapsed} ms of fake time`);
    if (mine) env.chain.mine();
    await env.clock.advance(stepMs);
    elapsed += stepMs;
  }
  return tracked;
}

describePg('the PostgreSQL reference store (examples/postgres-store)', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 20 });
  });

  afterAll(async () => {
    for (let i = 1; i <= schemas; i += 1) {
      await pool.query(`DROP SCHEMA IF EXISTS ${prefix}_${i} CASCADE`);
    }
    await pool.end();
  });

  describeOperationStoreContract(api, async () => {
    const { operations, advance } = await fresh();
    return { operations, advance };
  });
  describeLockManagerContract(api, async () => {
    const { locks, advance } = await fresh();
    return { locks, advance };
  });
  describeSequenceStoreContract(api, async () => ({
    sequences: (await fresh()).sequences,
  }));
  describeCursorStoreContract(api, async () => ({ cursors: (await fresh()).cursors }));

  describe('on its default clock, Date.now, with real sleeps', () => {
    describeLockManagerContract(
      api,
      async () => ({
        locks: createPostgresStores({ pool, schema: await freshSchema() }).locks,
        advance: (ms: number) => sleep(ms),
      }),
      { ttlMs: 250 },
    );
  });

  describe('beyond the contract suites', () => {
    it('serves findByRef from what another store instance (another process) just appended', async () => {
      // The ref guard needs read-your-writes across processes; the suites use one instance.
      const schema = await freshSchema();
      const writer = createPostgresStores({ pool, schema }).operations;
      const reader = createPostgresStores({ pool, schema }).operations;
      const { record } = await writer.create(sampleOperation());
      await writer.appendAttempt(
        'ns',
        record.id,
        sampleAttempt('x1'),
        {},
        record.version,
      );
      expect((await reader.findByRef('ns', 'ref-x1'))?.id).toBe(record.id);
    });

    it('gives two store instances claiming at once disjoint Operations and fresh tokens', async () => {
      const schema = await freshSchema();
      const one = createPostgresStores({ pool, schema }).operations;
      const two = createPostgresStores({ pool, schema }).operations;
      for (let i = 0; i < 6; i += 1) {
        await one.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }));
      }
      const [a, b] = await Promise.all([
        one.claimDue('ns', 'w1', 1_000, 500, 3),
        two.claimDue('ns', 'w2', 1_000, 500, 3),
      ]);
      const ids = [...a, ...b].map((r) => r.id);
      expect(new Set(ids).size).toBe(6);
      const tokens = [...a, ...b].map((r) => BigInt(r.claim?.token ?? '0'));
      expect(new Set(tokens).size).toBe(6);
    });

    it('keeps a top-level field it has no column for, so a newer record format reads back whole', async () => {
      const { operations } = await fresh();
      const newer = {
        ...sampleOperation({ format: 2 }),
        settlement: { batch: 'b-7', fee: 2n ** 70n, proof: new Uint8Array([9]) },
      } as NewOperation;
      const { record } = await operations.create(newer);
      const updated = await operations.update('ns', record.id, { state: 'prepared' }, 1);
      for (const read of [record, updated, await operations.get('ns', record.id)]) {
        expect(read).toMatchObject({
          format: 2,
          settlement: { batch: 'b-7', fee: 2n ** 70n, proof: new Uint8Array([9]) },
        });
      }
    });

    it('keeps the row out of a database error, which would otherwise name the idempotency key', async () => {
      // A not-null violation's `detail` lists every column of the failing row.
      const { operations } = await fresh();
      const idempotencyKey = 'withdrawal-7f3a9c-customer-4417';
      const malformed = {
        ...sampleOperation({ idempotencyKey }),
        intent: undefined,
      } as unknown as NewOperation;
      const error: unknown = await operations.create(malformed).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PostgresStoreError);
      expect(error).toMatchObject({ sqlState: '23502', column: 'intent' });
      const text = [String(error), JSON.stringify(error), String((error as Error).cause)];
      expect(text.join('\n')).not.toContain(idempotencyKey);
    });

    it('refuses an idempotency key that text cannot hold as given, storing nothing', async () => {
      // The core takes any 1-200 characters. Postgres refuses U+0000, and the driver would
      // turn each lone surrogate into U+FFFD, so 'k\uD800' and 'k\uDC00' would be one key.
      const { operations } = await fresh();
      for (const idempotencyKey of ['k\u0000', 'k\uD800', 'k\uDC00']) {
        const error: unknown = await operations
          .create(sampleOperation({ idempotencyKey }))
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(error).toMatchObject({ name: 'PostgresStoreError', sqlState: '22021' });
      }
      expect(await operations.list({ namespace: 'ns' })).toEqual([]);
      // A well-formed pair is one character, and is stored as it is.
      const { record } = await operations.create(
        sampleOperation({ idempotencyKey: 'k😀' }),
      );
      expect((await operations.getByKey('ns', 'k😀'))?.id).toBe(record.id);
    });

    it('indexes due Operations by the same terminal states the claim query excludes', () => {
      // claimDue writes TERMINAL_STATES into its query; the partial index must list the
      // same states, or the planner cannot use it.
      const states = TERMINAL_STATES.map((state) => `'${state}'`).join(', ');
      expect(readFileSync(SCHEMA_SQL_PATH, 'utf8')).toContain(`state NOT IN (${states})`);
    });
  });

  describe('under the engine (createFakeEnv)', () => {
    it('runs a transfer to proven finality, then a restart on the same stores recovers one that crashed before its broadcast', async () => {
      const schema = await freshSchema();
      // createFakeEnv makes its FakeClock after the stores exist, so the stores read the
      // clock through this indirection, which points at the env's clock once there is one.
      let clock: Pick<Clock, 'now'> = { now: () => Date.now() };
      const stores = createPostgresStores({
        pool,
        schema,
        clock: { now: () => clock.now() },
      });
      const operations = new FaultyOperationStore(stores.operations);
      const { signer, calls } = countingSigner();
      const env = await createFakeEnv({ signer, stores: { ...stores, operations } });
      clock = env.clock;

      const alice = env.stranger();
      const sub = await drive(
        env,
        env.bc.transfer({ to: alice, amount: 5n }, { idempotencyKey: 'pg-1' }),
      );
      const settled = await drive(env, sub.wait({ finality: 'final' }), {
        stepMs: 1_000,
        mine: true,
      });
      expect(settled.status).toMatchObject({ state: 'final', evidence: 'proven' });

      // The process dies right after it stored the signed Attempt, before the broadcast.
      operations.crashOn({ method: 'appendAttempt', timing: 'after' });
      const bob = env.stranger();
      await expect(
        drive(env, env.bc.transfer({ to: bob, amount: 7n }, { idempotencyKey: 'pg-2' })),
      ).rejects.toBeInstanceOf(CrashError);

      // A new process on the same stores sends the stored bytes again, never signing twice.
      const restarted = await env.restart({ killPrevious: true });
      expect(await drive(restarted, restarted.aio.operations.recover())).toMatchObject({
        rebroadcast: 1,
        failed: 0,
      });
      const listed = await drive(restarted, restarted.aio.operations.list());
      const crashed = listed.find((view) => view.idempotencyKey === 'pg-2');
      const recovered = await drive(
        restarted,
        restarted.bc.waitForConfirmation(crashed?.id ?? '', { finality: 'final' }),
        { stepMs: 1_000, mine: true },
      );
      expect(recovered.status).toMatchObject({ state: 'final', evidence: 'proven' });
      expect(calls()).toBe(2);
      expect([restarted.chain.balance(alice), restarted.chain.balance(bob)]).toEqual([
        5n,
        7n,
      ]);

      // The state is in Postgres, not in these objects: a new store instance reads it all.
      const reopened = createPostgresStores({ pool, schema });
      const records = await reopened.operations.list({ namespace: 'default' });
      expect(records.map((r) => [r.idempotencyKey, r.state, r.format])).toEqual([
        ['pg-1', 'final', OPERATION_FORMAT],
        ['pg-2', 'final', OPERATION_FORMAT],
      ]);
      for (const record of records) {
        const attempt = record.attempts[0];
        expect(await reopened.operations.getObservation(attempt?.id ?? '')).toMatchObject(
          {
            state: 'final',
            evidence: 'proven',
          },
        );
      }
      const { rows } = await pool.query<{ next: string; owner: string | null }>(
        `SELECT s.next::text, l.owner FROM ${schema}.sequences s
           JOIN ${schema}.leases l ON l.key = s.key`,
      );
      // Two nonces drawn, and the address lease released.
      expect(rows).toEqual([{ next: '2', owner: null }]);
    });
  });
});
