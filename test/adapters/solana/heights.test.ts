import { HeightIndex } from '../../../src/adapters/solana/heights';
import { MONITOR } from '../../../src/adapters/solana/rpc';
import { ProviderError, withContext } from '../../../src/core/errors/error';
import type { Transport } from '../../../src/core/transport/types';
import { nodeTransport, recording } from './support/harness';

function setup() {
  const t = nodeTransport();
  const { transport, calls } = recording(t.transport);
  return { ...t, calls, index: new HeightIndex(transport) };
}

describe('dense heights over slots', () => {
  it('maps every height to its block, skipping empty slots', async () => {
    const { node, run, index } = setup();
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 1) node.skip(i % 2 === 0 ? 1 : 2);
      node.produce();
    }
    for (let h = 0n; h <= node.head.height; h++) {
      expect(await run(index.slotAt(h, 'confirmed', MONITOR))).toBe(node.block(h)?.slot);
    }
    expect(
      await run(index.slotAt(node.head.height + 1n, 'confirmed', MONITOR)),
    ).toBeNull();
    expect(await run(index.slotAt(-1n, 'confirmed', MONITOR))).toBeNull();
  });

  it('answers finalized heights only up to the finalized block, and caches them for a forward scan', async () => {
    const { node, run, index, calls } = setup();
    node.skip(4);
    node.produce(10);
    const finalized = node.finalized.height;
    expect(await run(index.slotAt(finalized + 1n, 'finalized', MONITOR))).toBeNull();
    expect(await run(index.slotAt(3n, 'finalized', MONITOR))).toBe(node.block(3n)?.slot);
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((c) => c.tags.purpose === 'monitor' && c.tags.quorum === undefined),
    ).toBe(true);
    calls.length = 0;
    // A forward scan from 3 finds every later height in the pairs that answer cached.
    for (let h = 3n; h <= finalized; h++) {
      expect(await run(index.slotAt(h, 'finalized', MONITOR))).toBe(node.block(h)?.slot);
    }
    expect(calls).toEqual([]);
  });

  it('never caches a pair above the finalized block: a fork there moves it', async () => {
    const { node, run, index } = setup();
    node.produce(6);
    const old = node.block(5n)?.slot;
    expect(await run(index.slotAt(5n, 'confirmed', MONITOR))).toBe(old);
    node.reorg(2);
    node.skip(1);
    node.produce(2);
    expect(node.block(5n)?.slot).not.toBe(old);
    expect(await run(index.slotAt(5n, 'confirmed', MONITOR))).toBe(node.block(5n)?.slot);
  });

  it('widens its window for heights far below the head', async () => {
    const { node, run, index, calls } = setup();
    for (let i = 0; i < 600; i++) {
      node.produce();
      if (i % 5 === 0) node.skip(3);
    }
    expect(await run(index.slotAt(1n, 'confirmed', MONITOR))).toBe(node.block(1n)?.slot);
    expect(calls.filter((c) => c.method === 'getBlocks').length).toBeLessThanOrEqual(3);
  });

  it('refuses a block list that does not end at its anchor', async () => {
    const { node, run, index } = setup();
    node.produce(6);
    node.intercept = (_endpoint, method) =>
      method === 'getBlocks' ? { result: [1, 2, 3] } : undefined;
    await expect(run(index.slotAt(2n, 'confirmed', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    // agave answers an empty list when its root is below the range (a lagging backend).
    node.intercept = (_endpoint, method) =>
      method === 'getBlocks' ? { result: [] } : undefined;
    await expect(run(index.slotAt(2n, 'confirmed', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('refuses a list that leaves out a block, and caches nothing from it', async () => {
    const { node, run, index, calls } = setup();
    node.produce(6);
    // A ledger gap: slot 2 missing from the list shifts every counted height.
    node.intercept = (_endpoint, method) =>
      method === 'getBlocks' ? { result: [0, 1, 3, 4] } : undefined;
    await expect(run(index.slotAt(2n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    node.intercept = undefined;
    calls.length = 0;
    expect(await run(index.slotAt(2n, 'finalized', MONITOR))).toBe(node.block(2n)?.slot);
    // Nothing was cached from the gapped list: the good answer needed a fresh list.
    expect(calls.map((c) => c.method)).toContain('getBlocks');
  });

  it('answers a height a pruned endpoint no longer holds with a retryable error, in bounded calls', async () => {
    const t = nodeTransport({}, [{ name: 'pruned', firstAvailableHeight: 40 }]);
    const { transport, calls } = recording(t.transport);
    const index = new HeightIndex(transport);
    for (let i = 0; i < 60; i++) {
      t.node.produce();
      if (i % 4 === 0) t.node.skip(1);
    }
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(calls.length).toBeLessThanOrEqual(8);
    // A held height still resolves; a height not produced yet is null.
    expect(await t.run(index.slotAt(45n, 'finalized', MONITOR))).toBe(
      t.node.block(45n)?.slot,
    );
    expect(await t.run(index.slotAt(1_000n, 'confirmed', MONITOR))).toBeNull();
  });

  it('starts a page again at the first available block when the endpoint cannot list below it (X-note)', async () => {
    const t = nodeTransport({}, [{ name: 'bt', bigtableFailsBelow: 40n }]);
    const { transport, calls } = recording(t.transport);
    const index = new HeightIndex(transport);
    t.node.produce(200);
    // agave 4.3.0: getBlocks from below the local ledger fails when long-term storage
    // fails. A height just inside the ledger still resolves from the first held block.
    expect(await t.run(index.slotAt(45n, 'finalized', MONITOR))).toBe(
      t.node.block(45n)?.slot,
    );
    expect(calls.map((c) => c.method)).toEqual([
      'getSlot',
      'getBlock',
      'getBlocks',
      'getFirstAvailableBlock',
      'getBlocks',
      'getBlock',
    ]);
    expect(calls[4]?.params).toEqual([
      Number(t.node.block(40n)?.slot),
      Number(t.node.finalized.slot),
      { commitment: 'finalized' },
    ]);
    // Below it, the endpoint holds nothing: a retryable error that decides nothing, with
    // no page asked below the first available block.
    calls.length = 0;
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'the endpoint no longer holds the block at height 10',
    });
    expect(calls.filter((c) => c.method === 'getBlocks')).toHaveLength(2);
  });

  it('starts a page again only after a definitive RPC error', async () => {
    const t = nodeTransport({}, [{ name: 'bt', bigtableFailsBelow: 40n }]);
    t.node.produce(200);
    const failing = (error: unknown): Transport =>
      new Proxy(t.transport, {
        get(target, prop) {
          if (prop === 'rpc') {
            return (method: string, params: unknown, options: unknown) =>
              method === 'getBlocks'
                ? Promise.reject(error)
                : target.rpc(method, params, options as never);
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const definitive = new ProviderError('RPC_ERROR', 'getBlocks failed: x', {
      details: { rpcCode: -32602, rpcMessage: 'x' },
    });
    for (const error of [
      // An ambiguous one, or one without a JSON-RPC code, is no endpoint's answer.
      withContext(definitive, {}, { ambiguous: true }),
      new ProviderError('RPC_ERROR', 'getBlocks failed: x'),
    ]) {
      const { transport, calls } = recording(failing(error));
      await expect(
        t.run(new HeightIndex(transport).slotAt(45n, 'finalized', MONITOR)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      expect(calls.map((c) => c.method)).not.toContain('getFirstAvailableBlock');
    }
    const { transport, calls } = recording(failing(definitive));
    await expect(
      t.run(new HeightIndex(transport).slotAt(45n, 'finalized', MONITOR)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(calls.map((c) => c.method)).toContain('getFirstAvailableBlock');
  });

  it('turns any other RPC error into a retryable one that decides nothing', async () => {
    const t = nodeTransport({}, [{ name: 'bt', bigtableFailsBelow: 40n }]);
    const index = new HeightIndex(t.transport);
    t.node.produce(200);
    // agave 4.3.0's long-term-storage failure, on every page the endpoint is asked for.
    t.node.intercept = (_endpoint, method) =>
      method === 'getBlocks'
        ? {
            error: {
              code: -32602,
              message: 'BigTable query failed (maybe timeout due to too large range?)',
            },
          }
        : undefined;
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining('BigTable query failed') as unknown,
    });
    await expect(t.run(index.slotAt(150n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // An endpoint that cannot name its first available block keeps the list's own error.
    const blocks = t.node.intercept;
    t.node.intercept = (endpoint, method, params) =>
      method === 'getFirstAvailableBlock'
        ? { error: { code: -32601, message: 'Method not found' } }
        : blocks(endpoint, method, params);
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining('BigTable query failed') as unknown,
    });
    // An internal error on a header read.
    t.node.intercept = (_endpoint, method) =>
      method === 'getBlock'
        ? { error: { code: -32603, message: 'Internal error' } }
        : undefined;
    await expect(
      t.run(index.header(t.node.block(150n)?.slot as bigint, 'finalized', MONITOR)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    t.node.intercept = undefined;
    // Heights well inside the local ledger still resolve.
    expect(await t.run(index.slotAt(150n, 'finalized', MONITOR))).toBe(
      t.node.block(150n)?.slot,
    );
  });

  it('never reads a slot the endpoint cannot show as "no block"', async () => {
    const { node, run, index, calls } = setup();
    node.skip(2);
    node.produce(8);
    const slot = node.block(4n)?.slot as bigint;
    expect(await run(index.slotAt(4n, 'finalized', MONITOR))).toBe(slot);
    const answer = (code: number, message: string) => {
      node.intercept = (_endpoint, method) =>
        method === 'getBlock' ? { error: { code, message } } : undefined;
      return run(index.header(slot, 'finalized', MONITOR));
    };
    // Not reached yet: `null`, which only ever means "not visible yet".
    await expect(
      answer(-32004, `Block not available for slot ${slot}`),
    ).resolves.toBeNull();
    // Missing from long-term storage, or pruned: retryable, deciding nothing.
    await expect(
      answer(-32009, `Slot ${slot} was skipped, or missing in long-term storage`),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    await expect(
      answer(-32001, `Block ${slot} cleaned up, does not exist on node.`),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    // Skipped, where a list named a block: a contradiction that also drops the cache.
    await expect(
      answer(
        -32007,
        `Slot ${slot} was skipped, or missing due to ledger jump to recent snapshot`,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    node.intercept = undefined;
    calls.length = 0;
    expect(await run(index.slotAt(4n, 'finalized', MONITOR))).toBe(slot);
    expect(calls.map((c) => c.method)).toContain('getBlocks');
  });
});
