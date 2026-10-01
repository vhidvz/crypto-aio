// A17: health probes respect each endpoint's rate limit (found live on toncenter's keyless
// 1 request/second tier: probes bypassed the bucket, the height probe got HTTP 429, and the
// endpoint was excluded for an unknown height).
import type { EndpointConfig, HealthProbes } from '../../../src/core/transport/types';
import type { FakeClock } from '../../../src/testing/fake-clock';
import { drive, settle } from '../../../src/testing/fake-clock';
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

// The three long tests drive thousands of fake-clock steps; `--detectOpenHandles` slows each
// past Jest's 5-second default, so they carry explicit budgets (Plan 4 handoff §6).
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
    // These reads wait on the shared first-use identity check, not on the bucket, so the
    // height probe gets the first refilled token here. The bucket-level starvation pin is the
    // next test, 'puts probes ahead of reads already waiting for tokens'.
    const reads = Array.from({ length: 80 }, () => transport.rpc('r'));
    await drive(clock, transport.refreshHealth());
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('ok');
    await drive(clock, Promise.allSettled(reads));
    expect(state.limited).toBe(0);
  }, 30_000);

  it('puts probes ahead of reads already waiting for tokens (M1: no probe starvation)', async () => {
    const { fake, state } = oneRequestPerSecond();
    const { transport, clock } = setup([LIMITED], fake);
    state.clock = clock;
    transport.setProbes(both);
    await drive(clock, transport.refreshHealth());
    // Identity is confirmed, so these reads go straight to the bucket and wait there before
    // the next refresh's height probe does: at 1 request/second, 80 of them outlast its
    // 15-second deadline unless the probe goes first.
    const reads = Array.from({ length: 80 }, () => transport.rpc('r'));
    await settle();
    const started = clock.now();
    await drive(clock, transport.refreshHealth());
    expect(clock.now() - started).toBeLessThanOrEqual(1_000);
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
    await drive(clock, Promise.allSettled(reads));
    expect(state.limited).toBe(0);
  }, 30_000);

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

  // A monitor asks every `cadenceMs`, so each ask re-runs the failing refresh once its backoff
  // ends; with a 1-second backoff its probe would take every token of the 0.2 rps bucket.
  // 5 000 ms is the bucket's own refill period: a refresh then starts at the very moment a
  // token refills, so the floor must leave one token beyond the probes' own for the reads.
  it.each([1_000, 5_000])(
    'floors the failed-refresh backoff so plain reads still get tokens (P25-R6 M1, monitor every %i ms)',
    async (cadenceMs) => {
      const methods: string[] = [];
      const fake = new FakeFetch().route('https://a.test', (req) => {
        methods.push(method(req));
        return method(req) === 'height'
          ? { status: 503, text: '' }
          : rpcResult(req, 'ok');
      });
      const { transport, clock } = setup([{ ...LIMITED, rateLimit: { rps: 0.2 } }], fake);
      transport.setProbes({
        height: async (call) => BigInt(await call.rpc<string>('height')),
      });
      let watching = true;
      const monitor = (async () => {
        while (watching) {
          await transport.rpc('m', [], { purpose: 'monitor' }).catch(() => undefined);
          await clock.sleep(cadenceMs);
        }
      })();
      await settle();
      const reads = Array.from({ length: 4 }, () => transport.rpc('r'));
      const settled = await drive(clock, Promise.allSettled(reads));
      watching = false;
      await drive(clock, monitor);
      expect(settled).toEqual(
        Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: 'ok' })),
      );
      expect(methods.filter((name) => name === 'height').length).toBeGreaterThan(1);
    },
    30_000,
  );
});
