import { MemoryOperationStore, createMemoryStores } from '../../../src/core/store/memory';
import type { ContractTestApi } from '../../../src/testing/contracts/api';
import { describeOperationStoreContract } from '../../../src/testing/contracts/operations';

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
});
