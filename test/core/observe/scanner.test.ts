import type { MappingContext } from '../../../src/core/blockchain/mapping';
import type { AdapterManifest, DriverBlock } from '../../../src/core/driver/types';
import { EventBus } from '../../../src/core/events/bus';
import { noopLogger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import {
  Scanner,
  type ScanEvent,
  type ScannerDeps,
} from '../../../src/core/observe/scanner';
import { MemoryCursorStore } from '../../../src/core/store/memory';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { fakeDriverFactory } from '../../../src/testing/fake-driver';
import { thrown } from '../../helpers';

async function take(
  env: FakeEnv,
  iterator: AsyncIterator<ScanEvent>,
): Promise<ScanEvent> {
  const result = await env.run(iterator.next(), 500);
  if (result.done) throw new Error('scanner ended');
  return result.value;
}

const heightOf = (event: ScanEvent) =>
  event.type === 'block' ? event.block.height : event.to.height;

describe('scanner', () => {
  it('scans in order, decodes transfers, commits on ack and resumes from the stored cursor', async () => {
    const env = await createFakeEnv();
    const blocks: AioEvent[] = [];
    env.aio.on('scanner.block', (e) => blocks.push(e));
    const recipient = env.stranger();
    await env.run(env.bc.transfer({ to: recipient, amount: 7n }));
    env.chain.mine(3);
    const first = env.bc
      .scanner({ cursorKey: 'deposits', from: 1n })
      [Symbol.asyncIterator]();
    const one = await take(env, first);
    expect(one).toMatchObject({ type: 'block', block: { height: 1n } });
    if (one.type !== 'block') throw new Error('unreachable');
    expect(one.transactions[0]?.transfers[0]).toMatchObject({
      to: { canonical: recipient },
      amount: { base: 7n },
    });
    await one.ack();
    const two = await take(env, first);
    await two.ack();
    expect(heightOf(two)).toBe(2n);
    expect(blocks).toHaveLength(2);
    await first.return?.(undefined);
    const resumed = env.bc
      .scanner({ cursorKey: 'deposits', from: 1n })
      [Symbol.asyncIterator]();
    expect(heightOf(await take(env, resumed))).toBe(3n);
  });

  it('requires ack before the next event', async () => {
    const env = await createFakeEnv();
    env.chain.mine(2);
    const iterator = env.bc
      .scanner({ cursorKey: 'strict', from: 1n })
      [Symbol.asyncIterator]();
    await take(env, iterator);
    await expect(env.run(iterator.next())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('emits a rollback when the chain reorganizes under the cursor', async () => {
    const env = await createFakeEnv();
    env.chain.mine(3);
    const iterator = env.bc
      .scanner({ cursorKey: 'reorg', from: 1n })
      [Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) await (await take(env, iterator)).ack();
    env.chain.reorg(2);
    const rollback = await take(env, iterator);
    expect(rollback).toMatchObject({ type: 'rollback', to: { height: 1n } });
    if (rollback.type !== 'rollback') throw new Error('unreachable');
    expect(rollback.removed.map((r) => r.height)).toEqual([3n, 2n]);
    await rollback.ack();
    const replay = await take(env, iterator);
    expect(replay).toMatchObject({
      type: 'block',
      block: { height: 2n, hash: env.chain.block(2n)?.hash },
    });
  });

  it('detects a reorg that happened while the scanner was stopped', async () => {
    const env = await createFakeEnv();
    env.chain.mine(3);
    const before = env.bc
      .scanner({ cursorKey: 'offline', from: 1n })
      [Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) await (await take(env, before)).ack();
    await before.return?.(undefined);
    env.chain.reorg(2);
    const after = env.bc
      .scanner({ cursorKey: 'offline', from: 1n })
      [Symbol.asyncIterator]();
    expect(await take(env, after)).toMatchObject({
      type: 'rollback',
      to: { height: 1n },
    });
  });

  it('refuses to guess when the reorg is deeper than the window', async () => {
    const env = await createFakeEnv({ chain: { finalityDepth: 20 } });
    env.chain.mine(5);
    const iterator = env.bc
      .scanner({ cursorKey: 'deep', from: 1n, reorgWindow: 2 })
      [Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) await (await take(env, iterator)).ack();
    env.chain.reorg(4);
    await expect(env.run(iterator.next(), 500)).rejects.toMatchObject({
      code: 'SCANNER_REORG_TOO_DEEP',
    });
  });

  it('only emits finalized blocks in final mode', async () => {
    const env = await createFakeEnv();
    env.chain.mine(5);
    const iterator = env.bc
      .scanner({ cursorKey: 'final', from: 1n, mode: 'final' })
      [Symbol.asyncIterator]();
    await (await take(env, iterator)).ack();
    await (await take(env, iterator)).ack();
    let resolved = false;
    const pending = iterator.next().then((r) => {
      resolved = true;
      return r;
    });
    await env.clock.advance(3_000);
    expect(resolved).toBe(false);
    env.chain.mine();
    const next = await env.run(pending, 500);
    expect(next.value).toMatchObject({ type: 'block', block: { height: 3n } });
  });

  it('filters transactions by address', async () => {
    const env = await createFakeEnv();
    const wanted = env.stranger();
    await env.run(env.bc.transfer({ to: wanted, amount: 1n }));
    await env.run(env.bc.transfer({ to: env.stranger(), amount: 2n }));
    env.chain.mine();
    const iterator = env.bc
      .scanner({ cursorKey: 'filtered', from: 1n, filter: { addresses: [wanted] } })
      [Symbol.asyncIterator]();
    const event = await take(env, iterator);
    expect(
      event.type === 'block' &&
        event.transactions.map((t) => t.transfers[0]?.to.canonical),
    ).toEqual([wanted]);
  });

  it('requires the address-history capability for history()', async () => {
    const env = await createFakeEnv();
    await expect(env.run(env.bc.history(env.address))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});

describe('scanner cursor and delivery guarantees', () => {
  const checkpoint = (env: FakeEnv, height: bigint) => ({
    height,
    hash: env.chain.block(height)?.hash,
  });

  it('stores a plain-data cursor under a namespaced key and emits operational events only on ack', async () => {
    const env = await createFakeEnv();
    const events: AioEvent[] = [];
    env.aio.onAny((e) => {
      if (e.type.startsWith('scanner.')) events.push(e);
    });
    env.chain.mine(3);
    const key = 'default:fakechain:local:plain';
    const iterator = env.bc
      .scanner({ cursorKey: 'plain', from: 1n })
      [Symbol.asyncIterator]();
    const one = await take(env, iterator);
    expect(events).toHaveLength(0);
    expect(await env.stores.cursors.get(key)).toBeNull();
    await one.ack();
    await one.ack();
    expect(await env.stores.cursors.get(key)).toEqual({
      version: 1,
      cursor: {
        ...checkpoint(env, 1n),
        recent: [checkpoint(env, 0n), checkpoint(env, 1n)],
      },
    });
    const two = await take(env, iterator);
    // Concurrent acks of one event commit it once.
    await Promise.all([two.ack(), two.ack()]);
    expect((await env.stores.cursors.get(key))?.version).toBe(2);
    await (await take(env, iterator)).ack();
    env.chain.reorg(2);
    await (await take(env, iterator)).ack();
    expect(events).toEqual([
      ...['1', '2', '3'].map((height) => ({
        type: 'scanner.block',
        at: expect.any(Number),
        namespace: 'default',
        cursorKey: 'plain',
        height,
      })),
      {
        type: 'scanner.rollback',
        at: expect.any(Number),
        namespace: 'default',
        cursorKey: 'plain',
        toHeight: '1',
        removed: 2,
      },
    ]);
  });

  it('lets only one of two scanners on the same cursorKey commit an advance', async () => {
    const env = await createFakeEnv();
    env.chain.mine(2);
    const a = env.bc.scanner({ cursorKey: 'shared', from: 1n })[Symbol.asyncIterator]();
    const b = env.bc.scanner({ cursorKey: 'shared', from: 1n })[Symbol.asyncIterator]();
    const fromA = await take(env, a);
    const fromB = await take(env, b);
    await fromA.ack();
    await expect(fromB.ack()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(env.run(b.next())).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const resumed = env.bc
      .scanner({ cursorKey: 'shared', from: 1n })
      [Symbol.asyncIterator]();
    expect(heightOf(await take(env, resumed))).toBe(2n);
  });

  it('keeps a full reorg window below where a new cursor starts', async () => {
    const env = await createFakeEnv();
    env.chain.mine(5);
    const iterator = env.bc.scanner({ cursorKey: 'fresh' })[Symbol.asyncIterator]();
    const latest = await take(env, iterator);
    expect(latest).toMatchObject({ type: 'block', block: { height: 5n } });
    await latest.ack();
    env.chain.reorg(3);
    const rollback = await take(env, iterator);
    expect(rollback).toMatchObject({ type: 'rollback', to: checkpoint(env, 2n) });
    if (rollback.type !== 'rollback') throw new Error('unreachable');
    expect(rollback.removed.map((r) => r.height)).toEqual([5n, 4n, 3n]);
  });

  it('starts a final-mode cursor from a finalized parent only', async () => {
    const env = await createFakeEnv();
    env.chain.mine(5); // finalized height 2
    const iterator = env.bc
      .scanner({ cursorKey: 'final-start', from: 4n, mode: 'final' })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await env.clock.advance(3_000);
    env.chain.reorg(3); // replaces blocks 3..5, none of them final yet
    env.chain.mine(); // finalized height 4
    expect((await env.run(pending, 500)).value).toMatchObject({
      type: 'block',
      block: { height: 4n, hash: env.chain.block(4n)?.hash },
    });
  });

  it('waits instead of rolling back when the view cannot see the cursor blocks yet', async () => {
    const env = await createFakeEnv();
    env.chain.mine(3);
    const before = env.bc
      .scanner({ cursorKey: 'lagging', from: 1n })
      [Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) await (await take(env, before)).ack();
    await before.return?.(undefined);
    // Within the transport's lag tolerance, so the endpoint still serves monitor reads.
    env.chain.configureEndpoint('main', { lag: 2 });
    const after = env.bc
      .scanner({ cursorKey: 'lagging', from: 1n })
      [Symbol.asyncIterator]();
    let settled = false;
    const pending = after.next().finally(() => {
      settled = true;
    });
    await env.clock.advance(5_000);
    expect(settled).toBe(false);
    env.chain.configureEndpoint('main', { lag: 0 });
    env.chain.mine();
    expect((await env.run(pending, 500)).value).toMatchObject({
      type: 'block',
      block: { height: 4n },
    });
  });

  it('keeps polling through a transient provider outage', async () => {
    const env = await createFakeEnv();
    env.chain.mine(2);
    const iterator = env.bc
      .scanner({ cursorKey: 'outage', from: 1n })
      [Symbol.asyncIterator]();
    await (await take(env, iterator)).ack();
    env.chain.configureEndpoint('main', { down: true });
    let settled = false;
    const pending = iterator.next().finally(() => {
      settled = true;
    });
    await env.clock.advance(5_000);
    expect(settled).toBe(false);
    env.chain.configureEndpoint('main', { down: false });
    expect((await env.run(pending, 500)).value).toMatchObject({
      type: 'block',
      block: { height: 2n },
    });
  });

  it('ends cleanly, leaving no timer behind, when its signal aborts', async () => {
    const env = await createFakeEnv();
    env.chain.mine();
    const controller = new AbortController();
    const iterator = env.bc
      .scanner({ cursorKey: 'abort', from: 1n, signal: controller.signal })
      [Symbol.asyncIterator]();
    await (await take(env, iterator)).ack();
    const pending = iterator.next();
    await env.clock.advance(2_500);
    controller.abort();
    await expect(env.run(pending)).resolves.toEqual({ done: true, value: undefined });
    expect(env.clock.pending).toBe(0);
  });

  it('rejects invalid options up front', async () => {
    const env = await createFakeEnv();
    for (const options of [
      { cursorKey: '' },
      { cursorKey: 'k', from: 1 as unknown as bigint },
      { cursorKey: 'k', from: -1n },
      { cursorKey: 'k', mode: 'finalized' as 'final' },
      { cursorKey: 'k', reorgWindow: 0 },
      { cursorKey: 'k', reorgWindow: 1.5 },
      { cursorKey: 'k', pollIntervalMs: 0 },
    ]) {
      expect(thrown(() => env.bc.scanner(options))).toMatchObject({
        code: 'CONFIG_INVALID',
      });
    }
  });
});

describe('scanner stale-view guard', () => {
  it('decides no rollback while the view is behind the verified height, or none is known', async () => {
    const clock = new FakeClock();
    const cursors = new MemoryCursorStore();
    const hashes = new Map<bigint, string>([
      [0n, 'h0'],
      [1n, 'h1'],
      [2n, 'h2'],
    ]);
    let highest: bigint | undefined;
    const header = async (height: bigint): Promise<DriverBlock | null> => {
      const hash = hashes.get(height);
      return hash === undefined
        ? null
        : { height, hash, parentHash: hashes.get(height - 1n) ?? '' };
    };
    const mapping = {
      selection: { chain: { id: 'stub' }, network: { id: 'net', maxLagBlocks: 2 } },
      driver: {
        reader: { getBlockHeight: async () => 2n, getFinalizedHeight: async () => 2n },
      },
    } as unknown as MappingContext;
    const deps: ScannerDeps = {
      load: async () => ({
        mapping,
        blocks: { header, transactions: async () => [] },
        transport: { highestHeight: () => highest, hasProbes: () => true },
      }),
      cursors,
      events: new EventBus(clock, noopLogger),
      clock,
      namespace: 'test',
      defaults: { reorgWindow: 8, pollIntervalMs: 1_000 },
    };
    const recent = [0n, 1n, 2n].map((height) => ({ height, hash: `h${height}` }));
    await cursors.put('test:stub:net:k', { height: 2n, hash: 'h2', recent }, null);
    hashes.set(2n, 'h2-reorged');
    const iterator = new Scanner(deps, { cursorKey: 'k' })[Symbol.asyncIterator]();
    let settled = false;
    const pending = iterator.next().finally(() => {
      settled = true;
    });
    await clock.advance(3_000); // no verified height while probes exist
    highest = 10n;
    await clock.advance(3_000); // head 2 + tolerance 2 < 10
    expect(settled).toBe(false);
    highest = 2n;
    expect((await drive(clock, pending, 100)).value).toMatchObject({
      type: 'rollback',
      to: { height: 1n, hash: 'h1' },
    });
  });
});

describe('address history', () => {
  it('maps an indexer page for a normalized address; scanner() needs block-scan', async () => {
    const env = await createFakeEnv();
    const recipient = env.stranger();
    await env.run(env.bc.transfer({ to: recipient, amount: 3n }));
    env.chain.mine();
    const txId = env.chain.block(1n)?.txIds[0] as string;
    const calls: unknown[] = [];
    const indexed: AdapterManifest = {
      family: 'fake',
      library: 'indexed-sdk',
      chains: ['fakechain'],
      capabilities: ['address-history'],
      peerDependencies: [],
      load: async () => ({
        create: async (ctx) => {
          const driver = await fakeDriverFactory.create(ctx);
          return {
            ...driver,
            history: {
              list: async (address, options) => {
                calls.push({ address, ...options });
                const tx = await driver.reader.getTransaction(txId);
                return { items: tx ? [tx] : [], next: 'page-2' };
              },
            },
          };
        },
      }),
    };
    env.aio.use({ name: 'indexed', adapters: [indexed] });
    const bc = env.aio.blockchain({
      chain: 'fakechain',
      library: 'indexed-sdk' as 'fake-sdk',
    });
    const page = await env.run(bc.history(recipient.toUpperCase(), { cursor: 'page-1' }));
    expect(calls).toEqual([{ address: recipient, cursor: 'page-1', limit: 50 }]);
    expect(page.next).toBe('page-2');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: txId,
      transfers: [{ to: { canonical: recipient }, amount: { base: 3n } }],
    });
    expect(thrown(() => bc.scanner({ cursorKey: 'nope' }))).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});
