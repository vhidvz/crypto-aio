import assert from 'node:assert/strict';
import type { CursorStore } from '../../core/store/types';
import { rejectsWithCode, rejectsWithCodeKeepingOut, type ContractTestApi } from './api';

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
      const updated = { ...cursor, hash: 'h2' };
      assert.equal(await cursors.put('c', updated, 1), 2);
      const stored = { cursor: updated, version: 2 };
      assert.deepEqual(await cursors.get('c'), stored);
      await rejectsWithCode(cursors.put('c', cursor, 1), 'VERSION_CONFLICT');
      assert.deepEqual(await cursors.get('c'), stored);
      await rejectsWithCode(cursors.put('c', cursor, null), 'VERSION_CONFLICT');
      assert.deepEqual(await cursors.get('c'), stored);
    });

    api.it('keeps the key out of its errors', async () => {
      // A cursor key can name a watched wallet, and error messages reach logs.
      const { cursors } = await create();
      const key = 'deposits:bitcoin:mainnet:bc1qcursorkeyc0ffee0000000000000000000000';
      const cursor = { height: 1n, hash: 'h1', recent: [{ height: 1n, hash: 'h1' }] };
      await cursors.put(key, cursor, null);
      await rejectsWithCodeKeepingOut(
        cursors.put(key, cursor, null),
        'VERSION_CONFLICT',
        [key],
      );
      await rejectsWithCodeKeepingOut(cursors.put(key, cursor, 9), 'VERSION_CONFLICT', [
        key,
      ]);
    });
  });
}
