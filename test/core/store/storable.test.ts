/**
 * What a durable store needs from the caller's text and from the testing kit, found by
 * running the store ports on PostgreSQL (examples/postgres-store).
 */
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { storableText } from '../../../src/core/util/names';
import { sampleOperation } from '../../../src/testing/contracts/operations';
import { createFakeEnv } from '../../../src/testing/env';
import { FakeClock } from '../../../src/testing/fake-clock';
import { FaultyOperationStore } from '../../../src/testing/faulty-store';

describe('text a store keys by', () => {
  it('is well-formed Unicode without U+0000', () => {
    expect(storableText('order-42 ✓ 😀')).toBe(true);
    // A database refuses U+0000; a driver turns either lone surrogate into U+FFFD, so
    // these two keys would become one.
    for (const text of ['a\u0000b', 'k\uD800', 'k\uDC00', '\uDC00\uD800']) {
      expect(storableText(text)).toBe(false);
    }
  });

  it('refuses an idempotency key or a cursor key a store could not keep as it is', async () => {
    const env = await createFakeEnv();
    for (const key of ['k\uD800', 'k\u0000']) {
      await expect(
        env.run(
          env.bc.transfer({ to: env.stranger(), amount: 1n }, { idempotencyKey: key }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
      expect(() => env.bc.scanner({ cursorKey: key })).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(await env.stores.operations.list({ namespace: env.aio.namespace })).toEqual(
      [],
    );
  });
});

describe('the memory Operation store and the testing kit', () => {
  it('lists and purges nothing for a negative limit, as for 0', async () => {
    const store = new MemoryOperationStore(new FakeClock());
    await store.create(sampleOperation());
    await store.create(sampleOperation());
    expect(await store.list({ namespace: 'ns', limit: -1 })).toEqual([]);
    expect(await store.purge({ namespace: 'ns', limit: -1 })).toBe(0);
    expect(await store.list({ namespace: 'ns' })).toHaveLength(2);
  });

  it('passes purge through a FaultyOperationStore when the inner store has one', async () => {
    const inner = new MemoryOperationStore(new FakeClock());
    await inner.create(sampleOperation());
    const faulty = new FaultyOperationStore(inner);
    expect(await faulty.purge?.({ namespace: 'ns' })).toBe(1);
    const withoutPurge = Object.create(inner, { purge: { value: undefined } });
    expect(new FaultyOperationStore(withoutPurge).purge).toBeUndefined();
  });

  it('gives createFakeEnv the clock of stores built beforehand', async () => {
    const clock = new FakeClock();
    const operations = new MemoryOperationStore(clock);
    const env = await createFakeEnv({ clock, stores: { operations } });
    expect(env.clock).toBe(clock);
    await clock.advance(5_000);
    const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
    const stored = await operations.get(env.aio.namespace, sub.operationId);
    expect(stored?.createdAt).toBeGreaterThanOrEqual(clock.now() - 1_000);
  });
});
