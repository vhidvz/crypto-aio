import assert from 'node:assert/strict';
import type { LockManager } from '../../core/store/types';
import type { ContractTestApi } from './api';

export interface LockHarness {
  readonly locks: LockManager;
  /** Moves the store's notion of time forward (a fake clock, or a real sleep). */
  advance(ms: number): Promise<void>;
}

export function describeLockManagerContract(
  api: ContractTestApi,
  create: () => LockHarness | Promise<LockHarness>,
  options: { readonly ttlMs?: number } = {},
): void {
  const ttl = options.ttlMs ?? 1_000;
  api.describe('LockManager contract', () => {
    api.it('grants one holder at a time per key', async () => {
      const { locks } = await create();
      const a = await locks.acquire('k', 'a', ttl);
      assert.ok(a);
      assert.equal(a.owner, 'a');
      assert.equal(await locks.acquire('k', 'b', ttl), null);
      assert.equal(await locks.acquire('k', 'a', ttl), null, 'leases are not reentrant');
      assert.ok(await locks.acquire('other', 'b', ttl), 'keys are independent');
    });

    api.it('issues strictly increasing tokens across expiry and release', async () => {
      const { locks, advance } = await create();
      const a = await locks.acquire('k', 'a', ttl);
      assert.ok(a);
      await advance(ttl + 1);
      const b = await locks.acquire('k', 'b', ttl);
      assert.ok(b);
      assert.ok(b.token > a.token);
      await locks.release(b);
      const c = await locks.acquire('k', 'c', ttl);
      assert.ok(c);
      assert.ok(c.token > b.token);
    });

    api.it('rejects a stale worker after takeover', async () => {
      const { locks, advance } = await create();
      const stale = await locks.acquire('k', 'a', ttl);
      assert.ok(stale);
      await advance(ttl + 1);
      const fresh = await locks.acquire('k', 'b', ttl);
      assert.ok(fresh);
      assert.equal(await locks.renew(stale, ttl), null);
      await locks.release(stale);
      assert.equal(
        await locks.acquire('k', 'c', ttl),
        null,
        'stale release must not free the new holder',
      );
      assert.ok(await locks.renew(fresh, ttl));
    });

    api.it('renews before expiry but not after', async () => {
      const { locks, advance } = await create();
      const lease = await locks.acquire('k', 'a', ttl);
      assert.ok(lease);
      await advance(Math.floor(ttl / 2));
      const renewed = await locks.renew(lease, ttl);
      assert.ok(renewed);
      assert.equal(renewed.token, lease.token);
      await advance(ttl + 1);
      assert.equal(await locks.renew(renewed, ttl), null);
    });

    api.it('grants exactly one lease to concurrent acquirers', async () => {
      const { locks } = await create();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => locks.acquire('k', `w${i}`, ttl)),
      );
      assert.equal(results.filter(Boolean).length, 1);
    });
  });
}
