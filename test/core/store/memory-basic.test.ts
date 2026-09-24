import {
  MemoryCursorStore,
  MemoryLockManager,
  MemorySequenceStore,
} from '../../../src/core/store/memory';
import { DATA_CLASSIFICATION } from '../../../src/core/store/types';
import type { ContractTestApi } from '../../../src/testing/contracts/api';
import { describeCursorStoreContract } from '../../../src/testing/contracts/cursors';
import { describeLockManagerContract } from '../../../src/testing/contracts/locks';
import { describeSequenceStoreContract } from '../../../src/testing/contracts/sequences';
import { FakeClock } from '../../../src/testing/fake-clock';

const api: ContractTestApi = {
  describe: (n, f) => describe(n, f),
  it: (n, f) => it(n, f),
};

describeLockManagerContract(api, () => {
  const clock = new FakeClock();
  return { locks: new MemoryLockManager(clock), advance: (ms) => clock.advance(ms) };
});
describeSequenceStoreContract(api, () => ({ sequences: new MemorySequenceStore() }));
describeCursorStoreContract(api, () => ({ cursors: new MemoryCursorStore() }));

describe('DATA_CLASSIFICATION', () => {
  it('never classifies stored fields as secret and marks raw transactions until broadcast', () => {
    const classes = [
      ...Object.values(DATA_CLASSIFICATION.operation),
      ...Object.values(DATA_CLASSIFICATION.attempt),
      ...Object.values(DATA_CLASSIFICATION.observation),
    ];
    expect(classes).not.toContain('secret');
    expect(DATA_CLASSIFICATION.attempt.raw).toBe('sensitive-until-broadcast');
    expect(DATA_CLASSIFICATION.operation.intent).toBe('sensitive');
    expect(DATA_CLASSIFICATION.operation.state).toBe('operational');
  });
});

describe('memory store error messages', () => {
  // Store keys embed wallet addresses, and error messages reach logs.
  const key = 'seq:ns:c:n:0xWALLET';

  it('never include the store key', async () => {
    const sequences = new MemorySequenceStore();
    await sequences.put(key, { next: 1n, released: [], fence: 2n }, null);
    const conflict = await sequences
      .put(key, { next: 2n, released: [], fence: 2n }, null)
      .catch((e: Error) => e);
    const fenced = await sequences
      .put(key, { next: 2n, released: [], fence: 1n }, 1)
      .catch((e: Error) => e);
    const cursors = new MemoryCursorStore();
    const cursor = { height: 1n, hash: 'h', recent: [] };
    await cursors.put(key, cursor, null);
    const cursorConflict = await cursors.put(key, cursor, null).catch((e: Error) => e);
    expect([conflict, fenced, cursorConflict]).toEqual([
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      expect.objectContaining({ code: 'FENCING' }),
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    ]);
    for (const error of [conflict, fenced, cursorConflict]) {
      expect(String((error as Error).message)).not.toContain('0xWALLET');
    }
  });
});
