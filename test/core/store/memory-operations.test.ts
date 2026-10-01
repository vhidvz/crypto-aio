import { MemoryOperationStore, createMemoryStores } from '../../../src/core/store/memory';
import type { ClearableField } from '../../../src/core/store/types';
import type { ContractTestApi } from '../../../src/testing/contracts/api';
import {
  describeOperationStoreContract,
  sampleOperation,
} from '../../../src/testing/contracts/operations';
import { FakeClock } from '../../../src/testing/fake-clock';

const api: ContractTestApi = {
  describe: (n, f) => describe(n, f),
  it: (n, f) => it(n, f),
};

describeOperationStoreContract(api, () => {
  const clock = new FakeClock();
  return {
    operations: new MemoryOperationStore(clock),
    advance: (ms) => clock.advance(ms),
  };
});

describe('createMemoryStores', () => {
  it('creates all four stores', () => {
    const stores = createMemoryStores();
    expect(Object.keys(stores).sort()).toEqual([
      'cursors',
      'locks',
      'operations',
      'sequences',
    ]);
  });

  it('stamps every store from the same injected clock', async () => {
    const clock = new FakeClock();
    const stores = createMemoryStores(clock);

    const { record } = await stores.operations.create(sampleOperation());
    expect(record.createdAt).toBe(clock.now());
    expect(record.updatedAt).toBe(clock.now());

    await clock.advance(1_000);
    const updated = await stores.operations.update(
      record.namespace,
      record.id,
      { state: 'prepared' },
      record.version,
    );
    expect(updated.createdAt).toBe(record.createdAt);
    expect(updated.updatedAt).toBe(clock.now());

    const lease = await stores.locks.acquire('k', 'owner', 500);
    expect(lease?.expiresAt).toBe(clock.now() + 500);
  });
});

describe('MemoryOperationStore patches', () => {
  it("reads a caller's clear list once, so what is validated is what is cleared", async () => {
    const store = new MemoryOperationStore(new FakeClock());
    const { record } = await store.create(sampleOperation());
    let reads = 0;
    // An array that yields an allowed field on the first read and a store-owned one after.
    const fickle = new Proxy(['error'], {
      get(target, property, receiver) {
        if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
        reads += 1;
        const field = reads === 1 ? 'error' : 'attempts';
        return function* () {
          yield field;
        };
      },
    });
    const updated = await store.update(
      record.namespace,
      record.id,
      { clear: fickle as unknown as ClearableField[] },
      record.version,
    );
    expect(reads).toBe(1);
    expect(updated.attempts).toEqual([]);
  });
});
