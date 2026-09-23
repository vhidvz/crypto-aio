import assert from 'node:assert/strict';
import type { CursorStore } from '../../core/store/types';
import { rejectsWithCode, type ContractTestApi } from './api';

export interface CursorHarness {
  readonly cursors: CursorStore;
}

export function describeCursorStoreContract(
  api: ContractTestApi,
  create: () => CursorHarness | Promise<CursorHarness>,
): void {
  api.describe('CursorStore contract', () => {
    api.it('stores cursors with compare-and-set versions', async () => {
      const { cursors } = await create();
      assert.equal(await cursors.get('c'), null);
      const cursor = {
        height: 2n ** 40n,
        hash: 'h1',
        recent: [{ height: 2n ** 40n, hash: 'h1' }],
      };
      assert.equal(await cursors.put('c', cursor, null), 1);
      assert.deepEqual(await cursors.get('c'), { cursor, version: 1 });
      assert.equal(await cursors.put('c', { ...cursor, hash: 'h2' }, 1), 2);
      await rejectsWithCode(cursors.put('c', cursor, 1), 'VERSION_CONFLICT');
      await rejectsWithCode(cursors.put('c', cursor, null), 'VERSION_CONFLICT');
    });
  });
}
