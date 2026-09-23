import { MemoryOperationStore, createMemoryStores } from '../../../src/core/store/memory';
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

describeOperationStoreContract(api, () => ({ operations: new MemoryOperationStore() }));

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
