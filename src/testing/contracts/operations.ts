import assert from 'node:assert/strict';
import type { AttemptRecord, NewOperation, OperationStore } from '../../core/store/types';
import { rejectsWithCode, type ContractTestApi } from './api';

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
  });
}
