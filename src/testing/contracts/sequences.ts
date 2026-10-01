import assert from 'node:assert/strict';
import type { SequenceStore } from '../../core/store/types';
import { rejectsWithCode, rejectsWithCodeKeepingOut, type ContractTestApi } from './api';

export interface SequenceHarness {
  readonly sequences: SequenceStore;
}

export function describeSequenceStoreContract(
  api: ContractTestApi,
  create: () => SequenceHarness | Promise<SequenceHarness>,
): void {
  api.describe('SequenceStore contract', () => {
    api.it('returns null for unknown keys', async () => {
      const { sequences } = await create();
      assert.equal(await sequences.get('nope'), null);
    });

    api.it('creates with expectedVersion null and increments versions', async () => {
      const { sequences } = await create();
      await sequences.put('k', { next: 5n, released: [2n], fence: 1n }, null);
      const first = await sequences.get('k');
      assert.deepEqual(first, { next: 5n, released: [2n], fence: 1n, version: 1 });
      await sequences.put('k', { next: 6n, released: [], fence: 1n }, 1);
      assert.equal((await sequences.get('k'))?.version, 2);
    });

    api.it('rejects stale versions and leaves stored state unchanged', async () => {
      const { sequences } = await create();
      await sequences.put('k', { next: 1n, released: [], fence: 1n }, null);
      await sequences.put('k', { next: 2n, released: [], fence: 1n }, 1);
      const stored = { next: 2n, released: [], fence: 1n, version: 2 };
      await rejectsWithCode(
        sequences.put('k', { next: 3n, released: [], fence: 1n }, 1),
        'VERSION_CONFLICT',
      );
      assert.deepEqual(await sequences.get('k'), stored);
      await rejectsWithCode(
        sequences.put('k', { next: 3n, released: [], fence: 1n }, null),
        'VERSION_CONFLICT',
      );
      assert.deepEqual(await sequences.get('k'), stored);
    });

    api.it(
      'rejects writes from a stale fencing token and leaves stored state unchanged',
      async () => {
        const { sequences } = await create();
        await sequences.put('k', { next: 1n, released: [], fence: 2n }, null);
        const stored = { next: 1n, released: [], fence: 2n, version: 1 };
        await rejectsWithCode(
          sequences.put('k', { next: 9n, released: [], fence: 1n }, 1),
          'FENCING',
        );
        assert.deepEqual(await sequences.get('k'), stored);
      },
    );

    api.it('keeps the key out of its errors (B110)', async () => {
      // A sequence key embeds a wallet address, and error messages reach logs.
      const { sequences } = await create();
      const address = '0x5eC0FFEE00000000000000000000000000c0FFEE';
      const key = `ns:evm:mainnet:${address}`;
      await sequences.put(key, { next: 1n, released: [], fence: 2n }, null);
      for (const [state, expected, code] of [
        [{ next: 2n, released: [], fence: 2n }, null, 'VERSION_CONFLICT'],
        [{ next: 2n, released: [], fence: 2n }, 7, 'VERSION_CONFLICT'],
        [{ next: 2n, released: [], fence: 1n }, 1, 'FENCING'],
      ] as const) {
        await rejectsWithCodeKeepingOut(sequences.put(key, state, expected), code, [
          key,
          address,
          address.toLowerCase(),
        ]);
      }
    });

    api.it('round-trips large bigints exactly and isolates returned values', async () => {
      const { sequences } = await create();
      await sequences.put(
        'k',
        { next: 2n ** 70n, released: [2n ** 64n + 1n], fence: 3n },
        null,
      );
      const state = await sequences.get('k');
      assert.equal(state?.next, 2n ** 70n);
      (state?.released as bigint[]).push(1n);
      assert.deepEqual((await sequences.get('k'))?.released, [2n ** 64n + 1n]);
    });
  });
}
