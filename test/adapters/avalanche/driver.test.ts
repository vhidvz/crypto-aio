import { avalancheDriverFactory } from '../../../src/adapters/avalanche/driver';
import type { DriverContext } from '../../../src/core/driver/types';
import { noopLogger } from '../../../src/core/events/logger';
import type {
  EndpointCall,
  HealthProbes,
  Transport,
} from '../../../src/core/transport/types';
import { avalancheHarness, type Harness } from './support/harness';
import { chainOf, networkOf, type Vm } from './support/vectors';

/** Keeps the probes a driver sets (M12), passing every call through. */
function probing(transport: Transport) {
  const probes: HealthProbes[] = [];
  const proxy: Transport = new Proxy(transport, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'setProbes') {
        return (p: HealthProbes) => {
          probes.push(p);
          return target.setProbes(p);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { proxy, probes };
}

function contextOf(h: Harness, vm: Vm, network: 'fuji' | 'mainnet' = 'fuji') {
  const rpc = probing(h.transport);
  const indexer = probing(h.indexer);
  const ctx: DriverContext = {
    chain: chainOf(vm),
    network: networkOf(vm, network),
    library: '@avalabs/avalanchejs',
    transport: rpc.proxy,
    indexer: indexer.proxy,
    clock: h.clock,
    log: noopLogger,
    options: {},
  };
  return { ctx, rpc, indexer };
}

/** A probe's single-attempt calls, served by the harness transports. */
const direct = (transport: Transport): EndpointCall => ({
  rpc: (method, params) => transport.rpc(method, params),
  http: (request) => transport.http(request),
});

describe.each(['avm', 'pvm'] as Vm[])('the %s driver factory', (vm) => {
  it('probes both transports with the block at height 0 and the head', async () => {
    const h = avalancheHarness({ vm });
    h.node.mine();
    const { ctx, rpc, indexer } = contextOf(h, vm);
    const driver = await avalancheDriverFactory.create(ctx);
    expect(driver.ordering).toBe('inputs');
    expect([...driver.capabilities]).toContain('block-scan');
    expect(driver.limits?.({})).toEqual({ maxOutputs: 127 });
    expect(rpc.probes).toHaveLength(1);
    expect(indexer.probes).toHaveLength(1);
    const [node] = rpc.probes;
    const [data] = indexer.probes;
    expect(node?.expectedIdentity).toBe(h.config.genesisBlockId);
    expect(await h.run(node!.identity!(direct(h.transport)))).toBe(
      h.config.genesisBlockId,
    );
    expect(await h.run(node!.height!(direct(h.transport)))).toBe(1n);
    expect(data?.expectedIdentity).toBe(h.config.genesisBlockId);
    expect(await h.run(data!.identity!(direct(h.indexer)))).toBe(h.config.genesisBlockId);
    expect(await h.run(data!.height!(direct(h.indexer)))).toBe(1n);
  });

  it('refuses to run without an indexer', async () => {
    const h = avalancheHarness({ vm });
    const { ctx } = contextOf(h, vm);
    const { indexer: _indexer, ...bare } = ctx;
    await expect(avalancheDriverFactory.create(bare)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('requires an indexer provider'),
    });
  });

  it('hands out a fresh native client wired to the transport', async () => {
    const h = avalancheHarness({ vm });
    const { ctx } = contextOf(h, vm);
    const driver = await avalancheDriverFactory.create(ctx);
    const first = driver.createNativeClient?.();
    const second = driver.createNativeClient?.();
    expect(first?.client).not.toBe(second?.client);
    const client = first?.client as {
      context: { networkID: number; hrp: string; avaxAssetID: string };
      rpc<T>(method: string, params?: unknown): Promise<T>;
    };
    expect(client.context).toMatchObject({
      networkID: 5,
      hrp: 'fuji',
      avaxAssetID: h.config.avaxAssetId,
    });
    const prefix = vm === 'avm' ? 'avm' : 'platform';
    expect(await h.run(client.rpc<{ height: string }>(`${prefix}.getHeight`))).toEqual({
      height: '0',
    });
  });
});

describe('a node of another network', () => {
  it('fails the identity probe: a mainnet handle never reads a Fuji node', async () => {
    const h = avalancheHarness();
    const { ctx } = contextOf(h, 'avm', 'mainnet');
    const driver = await avalancheDriverFactory.create(ctx);
    // The endpoint is disabled by its identity probe; no read reaches it.
    await expect(h.run(driver.reader.getBlockHeight())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(h.transport.status().map((s) => s.state)).toEqual(['disabled']);
  });
});
