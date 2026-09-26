import assert from 'node:assert/strict';
import type {
  AttemptRecord,
  ClearableField,
  NewOperation,
  OperationPatch,
  OperationStore,
} from '../../core/store/types';
import { rejectsWithCode, type ContractTestApi } from './api';

/**
 * Narrows a `Promise.allSettled` result to its rejected variant, so a batch of
 * promises that are expected to include failures can be driven with a single
 * `Promise.allSettled` (a bare `Promise.all` would short-circuit on the first
 * rejection and discard the others) and then inspected without repeated casts.
 */
function isRejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

let counter = 0;

export function sampleOperation(overrides: Partial<NewOperation> = {}): NewOperation {
  counter += 1;
  return {
    id: `op_contract_${counter}`,
    namespace: 'ns',
    idempotencyKey: `key-${counter}`,
    intentHash: 'hash',
    context: {
      chain: 'c',
      network: 'n',
      library: 'lib',
      providers: ['p'],
      indexers: [],
      wallet: 'w',
      configHash: 'cfg',
    },
    kind: 'transfer',
    state: 'created',
    intent: {
      assetId: 'c:n/native',
      asset: 'native',
      outputs: [{ to: 'to', amount: 10n }],
      from: 'from',
      fee: 'normal',
    },
    attempts: [],
    ...overrides,
  };
}

export function sampleAttempt(
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  const fee = {
    kind: 'x',
    speed: 'normal' as const,
    charges: [{ asset: 'native' as const, amount: 1n, label: 'network' }],
    bound: 'exact' as const,
    details: {},
  };
  return {
    id,
    ref: { id: `ref-${id}`, idKind: 'tx-hash', canonical: true },
    raw: { encoding: 'hex', data: '00' },
    ordering: { kind: 'nonce', nonce: 7n },
    fee,
    unsigned: {
      payload: { encoding: 'hex', data: '00' },
      signingRequests: [
        {
          id: 'r0',
          scheme: 'secp256k1-ecdsa',
          payload: new Uint8Array([1, 2]),
          payloadKind: 'digest',
          publicKey: new Uint8Array([3]),
        },
      ],
      ordering: { kind: 'nonce', nonce: 7n },
      fee,
      summary: { asset: 'c:n/native', outputs: [] },
    },
    purpose: 'original',
    createdAt: 1,
    ...overrides,
  };
}

export interface OperationHarness {
  readonly operations: OperationStore;
  /** Moves the store's notion of time forward (a fake clock, or a real sleep). */
  advance(ms: number): Promise<void>;
}

export function describeOperationStoreContract(
  api: ContractTestApi,
  create: () => OperationHarness | Promise<OperationHarness>,
): void {
  api.describe('OperationStore contract', () => {
    api.it('creates if absent on (namespace, idempotencyKey)', async () => {
      const { operations } = await create();
      const first = await operations.create(sampleOperation({ idempotencyKey: 'same' }));
      assert.equal(first.created, true);
      assert.equal(first.record.version, 1);
      const second = await operations.create(sampleOperation({ idempotencyKey: 'same' }));
      assert.equal(second.created, false);
      assert.equal(second.record.id, first.record.id);
      const otherNs = await operations.create(
        sampleOperation({ idempotencyKey: 'same', namespace: 'other' }),
      );
      assert.equal(otherNs.created, true);
      assert.equal((await operations.getByKey('ns', 'same'))?.id, first.record.id);
      assert.equal(await operations.get('ns', 'missing'), null);
      assert.equal(await operations.getByKey('ns', 'missing'), null);
    });

    api.it(
      'rejects create when the runtime input carries a store-owned field, storing nothing',
      async () => {
        const { operations } = await create();
        const forbidden: Record<string, unknown> = {
          claim: { workerId: 'w', token: '1', until: 1 },
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        };
        for (const key of Object.keys(forbidden)) {
          const operation = {
            ...sampleOperation(),
            [key]: forbidden[key],
          } as unknown as NewOperation;
          await rejectsWithCode(operations.create(operation), 'INVALID_TRANSITION');
          assert.equal(await operations.get(operation.namespace, operation.id), null);
          assert.equal(
            await operations.getByKey(operation.namespace, operation.idempotencyKey),
            null,
          );
        }
      },
    );

    api.it('updates with compare-and-set versions and clears fields', async () => {
      const { operations } = await create();
      const { record } = await operations.create(sampleOperation());
      const updated = await operations.update(
        'ns',
        record.id,
        {
          state: 'prepared',
          reservation: { kind: 'nonce', nonce: 3n },
          error: {
            name: 'E',
            code: 'TIMEOUT',
            category: 'timeout',
            message: 'm',
            retryable: true,
            ambiguous: false,
            context: {},
          },
        },
        1,
      );
      assert.equal(updated.version, 2);
      assert.equal(updated.state, 'prepared');
      await rejectsWithCode(
        operations.update('ns', record.id, { state: 'signed' }, 1),
        'VERSION_CONFLICT',
      );
      await rejectsWithCode(
        operations.update('ns', 'missing', { state: 'signed' }, 1),
        'NOT_FOUND',
      );
      const cleared = await operations.update(
        'ns',
        record.id,
        { clear: ['reservation', 'error'] },
        2,
      );
      assert.equal(cleared.reservation, undefined);
      assert.equal(cleared.error, undefined);
      assert.equal(cleared.state, 'prepared');
    });

    api.it(
      'bumps the version on every successful update, even one that changes nothing',
      async () => {
        // R29: the engine fences a stale writer with a no-effect compare-and-set; a store
        // that skipped writing an unchanged record would let the stale write land.
        const { operations } = await create();
        const { record } = await operations.create(sampleOperation());
        assert.equal(record.error, undefined);
        const bumped = await operations.update(
          'ns',
          record.id,
          { clear: ['error'] },
          record.version,
        );
        assert.equal(bumped.version, record.version + 1);
        await rejectsWithCode(
          operations.update('ns', record.id, { state: 'prepared' }, record.version),
          'VERSION_CONFLICT',
        );
      },
    );

    api.it('appends attempts atomically with the state change', async () => {
      const { operations } = await create();
      const { record } = await operations.create(sampleOperation());
      const next = await operations.appendAttempt(
        'ns',
        record.id,
        sampleAttempt('a1'),
        { state: 'signed' },
        1,
      );
      assert.equal(next.version, 2);
      assert.equal(next.state, 'signed');
      assert.equal(next.activeAttemptId, 'a1');
      assert.equal(next.attempts.length, 1);
      await rejectsWithCode(
        operations.appendAttempt('ns', record.id, sampleAttempt('a1'), {}, 2),
        'INVALID_TRANSITION',
      );
      const stored = await operations.get('ns', record.id);
      const request = stored?.attempts[0]?.unsigned.signingRequests[0];
      assert.deepEqual(request?.payload, new Uint8Array([1, 2]));
      const ordering = stored?.attempts[0]?.ordering;
      assert.equal(ordering?.kind === 'nonce' ? ordering.nonce : undefined, 7n);
    });

    api.it('isolates returned records from the store', async () => {
      const { operations } = await create();
      const { record } = await operations.create(sampleOperation());
      (record.intent.outputs as { to: string; amount: bigint }[]).push({
        to: 'x',
        amount: 1n,
      });
      assert.equal((await operations.get('ns', record.id))?.intent.outputs.length, 1);
    });

    api.it('versions observations and finds operations by ref or tx hash', async () => {
      const { operations } = await create();
      const { record } = await operations.create(sampleOperation());
      await operations.appendAttempt(
        'ns',
        record.id,
        sampleAttempt('a2'),
        { state: 'signed' },
        1,
      );
      const base = {
        attemptId: 'a2',
        operationId: record.id,
        state: 'included' as const,
        evidence: 'observed' as const,
        confirmations: 1,
        txHash: 'canonical-hash',
        blockHeight: 2n ** 40n,
      };
      const obs = await operations.putObservation(base, null);
      assert.equal(obs.version, 1);
      await rejectsWithCode(operations.putObservation(base, null), 'VERSION_CONFLICT');
      assert.equal(
        (await operations.putObservation({ ...base, confirmations: 2 }, 1)).version,
        2,
      );
      assert.equal((await operations.getObservation('a2'))?.blockHeight, 2n ** 40n);
      assert.equal((await operations.findByRef('ns', 'ref-a2'))?.id, record.id);
      assert.equal((await operations.findByRef('ns', 'canonical-hash'))?.id, record.id);
      assert.equal(await operations.findByRef('other', 'ref-a2'), null);
    });

    api.it(
      'replaces an observation whole: a key left out or set to undefined reads back absent',
      async () => {
        // M9, P25-R14: the core clears a stale reason or block by leaving it out or setting
        // it to undefined. A store that merged records, or kept undefined as a value such as
        // null, would return a stale or wrong field.
        const { operations } = await create();
        const { record } = await operations.create(sampleOperation());
        await operations.appendAttempt(
          'ns',
          record.id,
          sampleAttempt('a3'),
          { state: 'signed' },
          1,
        );
        const failed = await operations.putObservation(
          {
            attemptId: 'a3',
            operationId: record.id,
            state: 'failed',
            evidence: 'observed',
            confirmations: 1,
            blockHeight: 7n,
            blockHash: 'block-7',
            reason: 'transfer bounced',
          },
          null,
        );
        await operations.putObservation(
          {
            attemptId: 'a3',
            operationId: record.id,
            state: 'pending',
            evidence: 'observed',
            confirmations: 0,
            reason: undefined,
          },
          failed.version,
        );
        const reread = await operations.getObservation('a3');
        assert.equal(reread?.state, 'pending');
        assert.equal(reread?.blockHeight, undefined);
        assert.equal(reread?.blockHash, undefined);
        assert.equal(reread?.reason, undefined);
      },
    );

    api.it('claims due operations exclusively and fences stale workers', async () => {
      const { operations } = await create();
      const a = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }))
      ).record;
      const b = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }))
      ).record;
      await operations.create(sampleOperation({ state: 'final', nextCheckAt: 100 }));
      await operations.create(
        sampleOperation({ state: 'submitted', nextCheckAt: 10_000 }),
      );
      // Unscheduled operations (no nextCheckAt) are still being built or signed: never due.
      await operations.create(sampleOperation({ state: 'prepared' }));
      const w1 = await operations.claimDue('ns', 'w1', 1_000, 500, 1);
      const w2 = await operations.claimDue('ns', 'w2', 1_000, 500, 10);
      assert.equal(w1.length, 1);
      assert.equal(w2.length, 1);
      assert.notEqual(w1[0]?.id, w2[0]?.id);
      assert.deepEqual(new Set([w1[0]?.id, w2[0]?.id]), new Set([a.id, b.id]));
      assert.equal((await operations.claimDue('ns', 'w3', 1_200, 500, 10)).length, 0);
      const staleClaim = w1[0]!;
      const retaken = await operations.claimDue('ns', 'w3', 1_600, 500, 10);
      const takeover = retaken.find((r) => r.id === staleClaim.id);
      assert.ok(takeover);
      assert.ok(BigInt(takeover.claim!.token) > BigInt(staleClaim.claim!.token));
      await rejectsWithCode(
        operations.update('ns', staleClaim.id, { nextCheckAt: 5 }, takeover.version, {
          claimToken: staleClaim.claim!.token,
        }),
        'FENCING',
      );
      await rejectsWithCode(
        operations.releaseClaim('ns', staleClaim.id, {
          claimToken: staleClaim.claim!.token,
        }),
        'FENCING',
      );
      await operations.releaseClaim('ns', staleClaim.id, {
        claimToken: takeover.claim!.token,
      });
      assert.equal((await operations.get('ns', staleClaim.id))?.claim, undefined);
    });

    api.it('lists by filter in creation order', async () => {
      const { operations } = await create();
      const one = (
        await operations.create(
          sampleOperation({
            namespace: 'list',
            intent: { ...sampleOperation().intent, from: 'alice' },
          }),
        )
      ).record;
      await operations.create(
        sampleOperation({
          namespace: 'list',
          state: 'final',
          intent: { ...sampleOperation().intent, from: 'alice' },
        }),
      );
      await operations.create(
        sampleOperation({
          namespace: 'list',
          intent: { ...sampleOperation().intent, from: 'bob' },
        }),
      );
      const alice = await operations.list({
        namespace: 'list',
        from: 'alice',
        states: ['created'],
      });
      assert.deepEqual(
        alice.map((r) => r.id),
        [one.id],
      );
      assert.equal((await operations.list({ namespace: 'list' })).length, 3);
      assert.equal((await operations.list({ namespace: 'list', limit: 2 })).length, 2);
    });

    api.it(
      'rejects patch fields outside the writable whitelist, leaving the record unchanged',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const afterAppend = await operations.appendAttempt(
          'ns',
          created.record.id,
          sampleAttempt('w1'),
          { state: 'signed' },
          1,
        );
        const snapshot = await operations.get('ns', created.record.id);
        await rejectsWithCode(
          operations.update(
            'ns',
            created.record.id,
            { attempts: [] } as unknown as OperationPatch,
            afterAppend.version,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
        await rejectsWithCode(
          operations.update(
            'ns',
            created.record.id,
            {
              claim: undefined,
              state: 'submitted',
              ...{ id: 'x' },
            } as unknown as OperationPatch,
            afterAppend.version,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
        await rejectsWithCode(
          operations.update(
            'ns',
            created.record.id,
            { clear: ['attempts', 'claim'] as unknown as ClearableField[] },
            afterAppend.version,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
      },
    );

    api.it(
      "rejects appendAttempt's patch fields outside the writable whitelist, leaving the record unchanged",
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const snapshot = await operations.get('ns', created.record.id);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('wl1'),
            { attempts: [] } as unknown as OperationPatch,
            1,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('wl2'),
            {
              claim: undefined,
              state: 'submitted',
              ...{ id: 'x' },
            } as unknown as OperationPatch,
            1,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('wl3'),
            { clear: ['attempts', 'claim'] as unknown as ClearableField[] },
            1,
          ),
          'INVALID_TRANSITION',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
      },
    );

    api.it(
      'rejects appendAttempt with a duplicate id even when the content differs, leaving the record unchanged',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const afterFirst = await operations.appendAttempt(
          'ns',
          created.record.id,
          sampleAttempt('dup'),
          { state: 'signed' },
          1,
        );
        const snapshot = await operations.get('ns', created.record.id);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('dup', {
              purpose: 'replacement',
              raw: { encoding: 'hex', data: 'ff' },
            }),
            { state: 'failed' },
            afterFirst.version,
          ),
          'INVALID_TRANSITION',
        );
        const after = await operations.get('ns', created.record.id);
        assert.deepEqual(after, snapshot);
        assert.equal(after?.attempts.length, 1);
        assert.equal(after?.version, afterFirst.version);
        assert.equal(after?.state, 'signed');
      },
    );

    api.it(
      'rejects appendAttempt with a stale expectedVersion, leaving the record unchanged',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        await operations.appendAttempt(
          'ns',
          created.record.id,
          sampleAttempt('s1'),
          { state: 'signed' },
          1,
        );
        const snapshot = await operations.get('ns', created.record.id);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('s2'),
            { state: 'submitted' },
            1,
          ),
          'VERSION_CONFLICT',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
      },
    );

    api.it(
      'rejects appendAttempt from a stale fencing token after a claim takeover, leaving the record unchanged',
      async () => {
        const { operations } = await create();
        const created = await operations.create(
          sampleOperation({ state: 'submitted', nextCheckAt: 100 }),
        );
        const [stale] = await operations.claimDue('ns', 'w1', 1_000, 500, 10);
        const [takeover] = await operations.claimDue('ns', 'w2', 1_600, 500, 10);
        const snapshot = await operations.get('ns', created.record.id);
        await rejectsWithCode(
          operations.appendAttempt(
            'ns',
            created.record.id,
            sampleAttempt('f1'),
            { state: 'signed' },
            takeover!.version,
            { claimToken: stale!.claim!.token },
          ),
          'FENCING',
        );
        assert.deepEqual(await operations.get('ns', created.record.id), snapshot);
      },
    );

    api.it(
      "isolates a stored attempt from later mutation of the caller's input",
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const attempt = sampleAttempt('iso1');
        await operations.appendAttempt(
          'ns',
          created.record.id,
          attempt,
          { state: 'signed' },
          1,
        );
        attempt.unsigned.signingRequests[0]!.payload[0] = 99;
        (attempt.raw as { data: string }).data = 'ff';
        const stored = await operations.get('ns', created.record.id);
        const storedAttempt = stored?.attempts[0];
        assert.deepEqual(
          storedAttempt?.unsigned.signingRequests[0]?.payload,
          new Uint8Array([1, 2]),
        );
        assert.equal(storedAttempt?.raw.data, '00');
      },
    );

    api.it('appends attempts in order without rewriting earlier ones', async () => {
      const { operations } = await create();
      const created = await operations.create(sampleOperation());
      const afterFirst = await operations.appendAttempt(
        'ns',
        created.record.id,
        sampleAttempt('a1'),
        { state: 'signed' },
        1,
      );
      const firstAttemptSnapshot = afterFirst.attempts[0];
      const afterSecond = await operations.appendAttempt(
        'ns',
        created.record.id,
        sampleAttempt('a2'),
        { state: 'submitted' },
        afterFirst.version,
      );
      assert.deepEqual(
        afterSecond.attempts.map((a) => a.id),
        ['a1', 'a2'],
      );
      assert.deepEqual(afterSecond.attempts[0], firstAttemptSnapshot);
    });

    api.it(
      'resolves N concurrent creates under one idempotency key, with distinct ids, to exactly one winner',
      async () => {
        const { operations } = await create();
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            operations.create(sampleOperation({ idempotencyKey: 'race-create' })),
          ),
        );
        const winners = results.filter((r) => r.created);
        assert.equal(winners.length, 1);
        const winnerId = winners[0]!.record.id;
        for (const r of results) assert.equal(r.record.id, winnerId);
        const listed = (await operations.list({ namespace: 'ns' })).filter(
          (r) => r.idempotencyKey === 'race-create',
        );
        assert.equal(listed.length, 1);
        assert.equal((await operations.getByKey('ns', 'race-create'))?.id, winnerId);
      },
    );

    api.it(
      'resolves N concurrent updates with the same expectedVersion to exactly one winner',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            operations.update('ns', created.record.id, { state: 'prepared' }, 1),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = results.filter(isRejected);
        assert.equal(rejected.length, 4);
        for (const r of rejected) {
          assert.equal((r.reason as { code?: unknown }).code, 'VERSION_CONFLICT');
        }
      },
    );

    api.it(
      'resolves N concurrent appendAttempt calls with the same expectedVersion to exactly one winner',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            operations.appendAttempt(
              'ns',
              created.record.id,
              sampleAttempt(`c${i}`),
              { state: 'signed' },
              1,
            ),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = results.filter(isRejected);
        assert.equal(rejected.length, 4);
        for (const r of rejected) {
          assert.equal((r.reason as { code?: unknown }).code, 'VERSION_CONFLICT');
        }
        assert.equal((await operations.get('ns', created.record.id))?.attempts.length, 1);
      },
    );

    api.it('returns disjoint id sets for two concurrent claimDue calls', async () => {
      const { operations } = await create();
      for (let i = 0; i < 4; i++) {
        await operations.create(
          sampleOperation({ state: 'submitted', nextCheckAt: 100 }),
        );
      }
      const [first, second] = await Promise.all([
        operations.claimDue('ns', 'w1', 1_000, 500, 2),
        operations.claimDue('ns', 'w2', 1_000, 500, 2),
      ]);
      assert.equal(first.length + second.length, 4);
      const firstIds = new Set(first.map((r) => r.id));
      for (const record of second) assert.equal(firstIds.has(record.id), false);
    });

    api.it(
      'returns the original record unchanged when a second create uses the same key but a different intentHash',
      async () => {
        const { operations } = await create();
        const first = await operations.create(
          sampleOperation({ idempotencyKey: 'conflict', intentHash: 'hash-a' }),
        );
        const second = await operations.create(
          sampleOperation({ idempotencyKey: 'conflict', intentHash: 'hash-b' }),
        );
        assert.equal(second.created, false);
        assert.deepEqual(second.record, first.record);
        assert.equal(second.record.intentHash, 'hash-a');
        assert.deepEqual(await operations.get('ns', first.record.id), first.record);
      },
    );

    api.it(
      'treats an explicit undefined patch value as a no-op for that field',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const withReservation = await operations.update(
          'ns',
          created.record.id,
          { reservation: { kind: 'nonce', nonce: 5n } },
          1,
        );
        const untouched = await operations.update(
          'ns',
          created.record.id,
          { reservation: undefined },
          withReservation.version,
        );
        assert.deepEqual(untouched.reservation, { kind: 'nonce', nonce: 5n });
        assert.deepEqual((await operations.get('ns', created.record.id))?.reservation, {
          kind: 'nonce',
          nonce: 5n,
        });
      },
    );

    api.it(
      'clear removes the field entirely, not just sets it to undefined',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const withReservation = await operations.update(
          'ns',
          created.record.id,
          { reservation: { kind: 'nonce', nonce: 5n } },
          1,
        );
        const cleared = await operations.update(
          'ns',
          created.record.id,
          { clear: ['reservation'] },
          withReservation.version,
        );
        assert.equal('reservation' in cleared, false);
        const reread = await operations.get('ns', created.record.id);
        assert.equal(reread !== null && 'reservation' in reread, false);
      },
    );

    api.it('never returns claims from another namespace', async () => {
      const { operations } = await create();
      await operations.create(
        sampleOperation({ namespace: 'other', state: 'submitted', nextCheckAt: 50 }),
      );
      await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 50 }));
      const claimed = await operations.claimDue('ns', 'w1', 1_000, 500, 10);
      assert.equal(claimed.length, 1);
      assert.equal(
        claimed.every((r) => r.namespace === 'ns'),
        true,
      );
    });

    api.it('orders claims by (nextCheckAt, createdAt)', async () => {
      const { operations } = await create();
      const c = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 300 }))
      ).record;
      const a = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }))
      ).record;
      const b = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 200 }))
      ).record;
      const claimed = await operations.claimDue('ns', 'w1', 1_000, 500, 10);
      assert.deepEqual(
        claimed.map((r) => r.id),
        [a.id, b.id, c.id],
      );
    });

    api.it(
      'limit picks the earliest due record after sorting, not by insertion order',
      async () => {
        const { operations } = await create();
        // Created in descending nextCheckAt order, so a limit-before-sort bug (e.g.
        // slicing then sorting, instead of sorting then slicing) would return the
        // first-inserted (highest nextCheckAt) record instead of the earliest-due one.
        await operations.create(
          sampleOperation({ state: 'submitted', nextCheckAt: 300 }),
        );
        await operations.create(
          sampleOperation({ state: 'submitted', nextCheckAt: 200 }),
        );
        const earliest = (
          await operations.create(
            sampleOperation({ state: 'submitted', nextCheckAt: 100 }),
          )
        ).record;
        const claimed = await operations.claimDue('ns', 'w1', 1_000, 500, 1);
        assert.deepEqual(
          claimed.map((r) => r.id),
          [earliest.id],
        );
      },
    );

    api.it(
      'limit 2 returns the two earliest due records in order, on fresh records',
      async () => {
        const { operations } = await create();
        await operations.create(
          sampleOperation({ namespace: 'limit2', state: 'submitted', nextCheckAt: 300 }),
        );
        const second = (
          await operations.create(
            sampleOperation({
              namespace: 'limit2',
              state: 'submitted',
              nextCheckAt: 200,
            }),
          )
        ).record;
        const first = (
          await operations.create(
            sampleOperation({
              namespace: 'limit2',
              state: 'submitted',
              nextCheckAt: 100,
            }),
          )
        ).record;
        const claimed = await operations.claimDue('limit2', 'w1', 1_000, 500, 2);
        assert.deepEqual(
          claimed.map((r) => r.id),
          [first.id, second.id],
        );
      },
    );

    api.it('breaks a nextCheckAt tie by createdAt, in creation order', async () => {
      const { operations, advance } = await create();
      const first = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }))
      ).record;
      await advance(10);
      const second = (
        await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }))
      ).record;
      const claimed = await operations.claimDue('ns', 'w1', 1_000, 500, 10);
      assert.deepEqual(
        claimed.map((r) => r.id),
        [first.id, second.id],
      );
    });

    api.it('limit 0 returns no claims', async () => {
      const { operations } = await create();
      await operations.create(sampleOperation({ state: 'submitted', nextCheckAt: 100 }));
      assert.deepEqual(await operations.claimDue('ns', 'w1', 1_000, 500, 0), []);
    });

    api.it('returns matching records in creation order', async () => {
      const { operations } = await create();
      const a = (await operations.create(sampleOperation({ namespace: 'order' }))).record;
      const b = (await operations.create(sampleOperation({ namespace: 'order' }))).record;
      const c = (await operations.create(sampleOperation({ namespace: 'order' }))).record;
      const found = await operations.list({ namespace: 'order' });
      assert.deepEqual(
        found.map((r) => r.id),
        [a.id, b.id, c.id],
      );
    });

    api.it(
      'putObservation never changes the Operation version, and rejects a stale expectedVersion',
      async () => {
        const { operations } = await create();
        const created = await operations.create(sampleOperation());
        const afterAppend = await operations.appendAttempt(
          'ns',
          created.record.id,
          sampleAttempt('obs1'),
          { state: 'signed' },
          1,
        );
        const base = {
          attemptId: 'obs1',
          operationId: created.record.id,
          state: 'included' as const,
          evidence: 'observed' as const,
          confirmations: 1,
        };
        await operations.putObservation(base, null);
        assert.equal(
          (await operations.get('ns', created.record.id))?.version,
          afterAppend.version,
        );
        await operations.putObservation({ ...base, confirmations: 2 }, 1);
        assert.equal(
          (await operations.get('ns', created.record.id))?.version,
          afterAppend.version,
        );
        await rejectsWithCode(
          operations.putObservation({ ...base, confirmations: 3 }, 1),
          'VERSION_CONFLICT',
        );
      },
    );

    api.it(
      'does not resolve a tx hash to an operation with the same id in a different namespace',
      async () => {
        const { operations } = await create();
        const sharedId = 'op_shared_1';
        await operations.create(
          sampleOperation({ id: sharedId, namespace: 'ns-a', idempotencyKey: 'key-a' }),
        );
        await operations.create(
          sampleOperation({ id: sharedId, namespace: 'ns-b', idempotencyKey: 'key-b' }),
        );
        await operations.appendAttempt(
          'ns-a',
          sharedId,
          sampleAttempt('shared-attempt'),
          { state: 'signed' },
          1,
        );
        await operations.putObservation(
          {
            attemptId: 'shared-attempt',
            operationId: sharedId,
            state: 'included',
            evidence: 'observed',
            confirmations: 1,
            txHash: 'shared-hash',
          },
          null,
        );
        const found = await operations.findByRef('ns-a', 'shared-hash');
        assert.equal(found?.id, sharedId);
        assert.equal(found?.namespace, 'ns-a');
        assert.equal(await operations.findByRef('ns-b', 'shared-hash'), null);
      },
    );
  });
}
