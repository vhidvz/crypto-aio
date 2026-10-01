// A closed container stops its worker loops and refuses new ones, so
// it never claims another Operation from a shared store and never keeps the process alive.
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { createFakeEnv } from '../../../src/testing';
import { settle } from '../../../src/testing/fake-clock';

/** An operation store that counts the claims workers make. */
class CountingStore extends MemoryOperationStore {
  claims = 0;

  override claimDue(
    ...args: Parameters<MemoryOperationStore['claimDue']>
  ): ReturnType<MemoryOperationStore['claimDue']> {
    this.claims += 1;
    return super.claimDue(...args);
  }
}

describe('close() stops the workers', () => {
  it('ends a running monitor loop and claims nothing after close', async () => {
    const operations = new CountingStore();
    const env = await createFakeEnv({ stores: { operations } });
    let ended = false;
    const loop = env.aio.monitor.start({ workerId: 'w1' }).then(() => {
      ended = true;
    });
    await env.clock.advance(5_000);
    await settle();
    expect(operations.claims).toBeGreaterThan(0);
    expect(ended).toBe(false);
    await env.aio.close();
    await settle();
    expect(ended).toBe(true);
    const before = operations.claims;
    await env.clock.advance(60_000);
    await settle();
    expect(operations.claims).toBe(before);
    await loop;
  });

  it('stops a loop started with its own signal too', async () => {
    const env = await createFakeEnv();
    const controller = new AbortController();
    let ended = false;
    void env.aio.monitor.start({ signal: controller.signal }).then(() => {
      ended = true;
    });
    await settle();
    await env.aio.close();
    await settle();
    expect(ended).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it('refuses a new loop, pass or recovery once closed', async () => {
    const env = await createFakeEnv();
    await env.aio.close();
    for (const work of [
      () => env.aio.monitor.start(),
      () => env.aio.monitor.runOnce(),
      () => env.aio.operations.recover(),
    ]) {
      await expect(work()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    }
  });
});
