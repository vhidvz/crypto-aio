import type { AdapterManifest } from '../../../src/core/driver/types';
import { createLogger } from '../../../src/core/events/logger';
import { native } from '../../../src/native';
import { createFakeEnv } from '../../../src/testing/env';
import { fakeManifest, fakePlugin } from '../../../src/testing/fake-plugin';

describe('closing native clients (N6)', () => {
  it('stops waiting for a native client that never finishes closing', async () => {
    let started = 0;
    const stuck: AdapterManifest = {
      ...fakeManifest,
      load: async () => {
        const factory = await fakeManifest.load();
        return {
          create: async (ctx) => ({
            ...(await factory.create(ctx)),
            createNativeClient: () => ({
              client: {},
              close: () => {
                started += 1;
                return new Promise<void>(() => undefined);
              },
            }),
          }),
        };
      },
    };
    const logs: unknown[][] = [];
    const env = await createFakeEnv({
      aio: {
        logger: createLogger('n6', (...record) => logs.push(record)),
        plugins: [{ ...fakePlugin(), adapters: [stuck] }],
      },
    });
    await env.run(native(env.bc, 'fake-sdk'));
    const before = env.clock.now();
    await env.run(env.aio.close(), 1_000);
    expect(started).toBe(1);
    expect(env.clock.now() - before).toBeGreaterThanOrEqual(5_000);
    expect(logs.filter(([level]) => level === 'warn')).toEqual([
      ['warn', 'n6', 'native client close timed out', { timeoutMs: 5_000 }],
    ]);
    await expect(env.run(env.bc.getBlockHeight())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});
