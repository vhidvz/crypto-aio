import type { OrderingData } from '../../../src/core/model/ordering';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { OperationRecord } from '../../../src/core/store/types';
import {
  describeOperationStoreContract,
  type OperationHarness,
} from '../../../src/testing/contracts/operations';
import { FakeClock } from '../../../src/testing/fake-clock';

type Fault = (ordering: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** A durable-store bug in how one ordering property is kept, applied on every read. */
class FaultyOrderings extends MemoryOperationStore {
  constructor(readonly fault: Fault) {
    super(new FakeClock());
  }

  override async get(namespace: string, id: string): Promise<OperationRecord | null> {
    const record = await super.get(namespace, id);
    if (!record) return record;
    const fix = (ordering: OrderingData) =>
      this.fault(
        ordering as Readonly<Record<string, unknown>>,
      ) as unknown as OrderingData;
    return {
      ...record,
      attempts: record.attempts.map((attempt) => ({
        ...attempt,
        ordering: fix(attempt.ordering),
        unsigned: { ...attempt.unsigned, ordering: fix(attempt.unsigned.ordering) },
      })),
    };
  }
}

/** The contract's ordering test alone, run against the store `create` builds. */
function orderingTest(create: () => OperationHarness): () => Promise<void> {
  let found: (() => Promise<void>) | undefined;
  describeOperationStoreContract(
    {
      describe: (_name, fn) => fn(),
      it: (name, fn) => {
        if (name.startsWith('keeps every ordering whole')) found = fn;
      },
    },
    create,
  );
  if (!found) throw new Error('the contract has no ordering test');
  return found;
}

const without =
  (key: string): Fault =>
  (ordering) => {
    const { [key]: _dropped, ...rest } = ordering;
    return rest;
  };
const map =
  (key: string, change: (value: unknown) => unknown): Fault =>
  (ordering) =>
    key in ordering ? { ...ordering, [key]: change(ordering[key]) } : { ...ordering };

const FAULTS: readonly (readonly [string, Fault])[] = [
  ["Tron's refBlockHash dropped", without('refBlockHash')],
  ['a Solana blockhashSlot read back as a number', map('blockhashSlot', Number)],
  ['a TON validFrom moved later', map('validFrom', (v) => (v as number) + 1)],
  ['an EVM nonce rounded through a double', map('nonce', (v) => BigInt(Number(v)))],
  ['UTXO inputs in another order', map('inputs', (v) => [...(v as string[])].reverse())],
  [
    'an expiresAtMs rounded down to seconds',
    map('expiresAtMs', (v) => Math.floor((v as number) / 1000) * 1000),
  ],
];

describe('the operation-store contract keeps orderings whole', () => {
  it('passes the memory store', async () => {
    await orderingTest(() => ({
      operations: new MemoryOperationStore(new FakeClock()),
      advance: async () => undefined,
    }))();
  });

  it.each(FAULTS)('fails a store that keeps %s', async (_name, fault) => {
    const run = orderingTest(() => ({
      operations: new FaultyOrderings(fault),
      advance: async () => undefined,
    }));
    await expect(run()).rejects.toThrow(/ordering/);
  });
});
