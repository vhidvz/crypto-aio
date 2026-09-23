import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, rpcResult, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const method = (req: FakeRequest) => req.json<{ method: string }>().method;

describe('HttpTransport health', () => {
  it('disables endpoints that serve another network', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) =>
        rpcResult(req, method(req) === 'chain_id' ? '5' : 'from-a'),
      )
      .route('https://b.test', (req) =>
        rpcResult(req, method(req) === 'chain_id' ? '1' : 'from-b'),
      );
    const { transport, clock, seen } = setup([A, B], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('from-b');
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.misconfigured',
        endpointId: 'a',
        expected: '1',
        actual: '5',
      }),
    );
    expect(transport.status().find((s) => s.id === 'a')?.state).toBe('disabled');
    const before = fake.callsTo('https://a.test').length;
    await drive(clock, transport.rpc('y'));
    expect(fake.callsTo('https://a.test')).toHaveLength(before);
  });

  it('excludes lagging endpoints from monitor and proof reads only', async () => {
    const heights: Record<string, string> = { a: '90', b: '100' };
    const handler = (name: string) => (req: FakeRequest) =>
      rpcResult(req, method(req) === 'height' ? heights[name] : name);
    const fake = new FakeFetch()
      .route('https://a.test', handler('a'))
      .route('https://b.test', handler('b'));
    const { transport, clock } = setup(
      [
        { ...A, priority: 0 },
        { ...B, priority: 1 },
      ],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes({
      height: async (call) => BigInt(await call.rpc<string>('height')),
    });
    await drive(clock, transport.refreshHealth());
    expect(transport.highestHeight()).toBe(100n);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('a');
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('b');
    expect(transport.status().find((s) => s.id === 'a')).toMatchObject({
      state: 'lagging',
      lag: 10n,
    });
  });

  it('requires agreement for quorum reads', async () => {
    const answers: Record<string, unknown> = { a: { h: '10' }, b: { h: '11' } };
    const handler = (name: string) => (req: FakeRequest) => rpcResult(req, answers[name]);
    const fake = new FakeFetch()
      .route('https://a.test', handler('a'))
      .route('https://b.test', handler('b'));
    const { transport, clock, seen } = setup([A, B], fake);
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.inconsistent',
        method: 'fin',
        endpointIds: ['a', 'b'],
      }),
    );
    answers.b = { h: '10' };
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).resolves.toEqual({ h: '10' });
    const solo = setup([A], fake);
    await expect(
      drive(solo.clock, solo.transport.rpc('fin', [], { quorum: 'proof' })),
    ).resolves.toEqual({ h: '10' });
  });

  it('fans out broadcasts and succeeds if any endpoint accepts', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 503, text: '' }))
      .route('https://b.test', (req) => rpcResult(req, 'accepted'));
    const { transport, clock } = setup([A, B], fake);
    await expect(
      drive(
        clock,
        transport.rpc('send', [], { fanout: 2, retry: 'ambiguous-on-failure' }),
      ),
    ).resolves.toBe('accepted');
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
  });

  it('refreshes health only when stale', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcResult(req, 'x'));
    const { transport, clock } = setup([A], fake, { healthIntervalMs: 15_000 });
    let probes = 0;
    transport.setProbes({
      height: async () => {
        probes += 1;
        return 1n;
      },
    });
    await drive(clock, transport.ensureFreshHealth());
    await drive(clock, transport.ensureFreshHealth());
    expect(probes).toBe(1);
    await clock.advance(15_000);
    await drive(clock, transport.ensureFreshHealth());
    expect(probes).toBe(2);
  });
});
