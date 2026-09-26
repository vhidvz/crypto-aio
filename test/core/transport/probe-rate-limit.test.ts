// A17: health probes respect each endpoint's rate limit (found live on toncenter's keyless
// 1 request/second tier: probes bypassed the bucket, the height probe got HTTP 429, and the
// endpoint was excluded for an unknown height).
import type { EndpointConfig, HealthProbes } from '../../../src/core/transport/types';
import type { FakeClock } from '../../../src/testing/fake-clock';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, rpcResult, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const LIMITED: EndpointConfig = {
  name: 'a',
  url: 'https://a.test/rpc',
  rateLimit: { rps: 1 },
};
const method = (req: FakeRequest) => req.json<{ method: string }>().method;

/** A server that allows one request per second and answers HTTP 429 to anything faster. */
function oneRequestPerSecond() {
  const state: { clock?: FakeClock; last?: number; limited: number; gaps: number[] } = {
    limited: 0,
    gaps: [],
  };
  const fake = new FakeFetch().route('https://a.test', (req) => {
    const now = state.clock?.now() ?? 0;
    if (state.last !== undefined) {
      state.gaps.push(now - state.last);
      if (now - state.last < 1_000) {
        state.limited += 1;
        return { status: 429, text: '' };
      }
    }
    state.last = now;
    const answers: Record<string, string> = { chain_id: '1', height: '100' };
    return rpcResult(req, answers[method(req)] ?? 'ok');
  });
  return { fake, state };
}

const identity: HealthProbes = {
  identity: (call) => call.rpc<string>('chain_id'),
  expectedIdentity: '1',
};
const both: HealthProbes = {
  ...identity,
  height: async (call) => BigInt(await call.rpc<string>('height')),
};

describe('health probes inside the rate limit (A17)', () => {
  it('keeps a 1 request/second endpoint healthy through probes and reads', async () => {
    const { fake, state } = oneRequestPerSecond();
    const { transport, clock } = setup([LIMITED], fake);
    state.clock = clock;
    transport.setProbes(both);
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('ok');
    expect(state.limited).toBe(0);
    expect(state.gaps.every((gap) => gap >= 1_000)).toBe(true);
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
  });

  it("runs a first-use identity probe before the request's own token", async () => {
    const { fake, state } = oneRequestPerSecond();
    const { transport, clock } = setup([LIMITED], fake);
    state.clock = clock;
    transport.setProbes(identity);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('ok');
    await expect(drive(clock, transport.rpc('y'))).resolves.toBe('ok');
    expect(fake.calls.map((call) => JSON.parse(call.body ?? '{}').method)).toEqual([
      'chain_id',
      'x',
      'y',
    ]);
    expect(state.limited).toBe(0);
  });

  it('keeps probes healthy behind 80 queued reads (M1: no probe starvation)', async () => {
    const { fake, state } = oneRequestPerSecond();
    const { transport, clock } = setup([LIMITED], fake);
    state.clock = clock;
    transport.setProbes(both);
    const reads = Array.from({ length: 80 }, () => transport.rpc('r'));
    await drive(clock, transport.refreshHealth());
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('ok');
    await drive(clock, Promise.allSettled(reads));
    expect(state.limited).toBe(0);
  });

  it('keeps a failed first-use identity probe as the request error, spending no token (M2)', async () => {
    const methods: string[] = [];
    const fake = new FakeFetch().route('https://a.test', (req) => {
      methods.push(method(req));
      return method(req) === 'chain_id'
        ? { status: 503, text: '' }
        : rpcResult(req, 'ok');
    });
    const { transport, clock } = setup([LIMITED], fake);
    transport.setProbes(identity);
    const started = clock.now();
    await expect(drive(clock, transport.rpc('x'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: "identity probe failed for endpoint 'a'",
      cause: expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    });
    expect(methods).toEqual(['chain_id']);
    // No token was spent on the request: it never waited out the 1-second refill.
    expect(clock.now() - started).toBeLessThan(1_000);
  });
});
