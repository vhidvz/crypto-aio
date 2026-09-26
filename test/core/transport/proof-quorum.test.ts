// A14 (handoff N5, found by Plan 3): height exclusion must never shrink a quorum read, and
// one endpoint that over-reports its head must never become the only proof endpoint.
import type { EndpointCall, EndpointConfig } from '../../../src/core/transport/types';
import { drive, settle } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  hang,
  rpcResult,
  type FakeRequest,
} from '../../../src/testing/fake-fetch';
import { setup } from './support';

const method = (req: FakeRequest) => req.json<{ method: string }>().method;
const endpoint = (name: string, priority = 0): EndpointConfig => ({
  name,
  url: `https://${name}.test/rpc`,
  priority,
});

/**
 * Endpoints reporting `heights` to the height probe (read live; `'down'` answers HTTP 503)
 * and `answers` (default 'fact') to 'fin'.
 */
function network(heights: Record<string, string>, answers: Record<string, string> = {}) {
  const fake = new FakeFetch();
  for (const name of Object.keys(heights)) {
    fake.route(`https://${name}.test`, (req) => {
      if (method(req) !== 'height') return rpcResult(req, answers[name] ?? 'fact');
      return heights[name] === 'down'
        ? { status: 503, text: '' }
        : rpcResult(req, heights[name]);
    });
  }
  const finCalls = (name: string) =>
    fake
      .callsTo(`https://${name}.test`)
      .filter((call) => JSON.parse(call.body ?? '{}').method === 'fin').length;
  return { fake, finCalls };
}
const probes = {
  height: async (call: EndpointCall) => BigInt(await call.rpc<string>('height')),
};

describe('proof quorum and height exclusion (A14)', () => {
  it('never lets one over-reporting endpoint become the sole proof endpoint', async () => {
    const { fake, finCalls } = network({ liar: '1000000', honest: '100' });
    const { transport, clock } = setup(
      [endpoint('liar', 0), endpoint('honest', 1)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    // The monitor view still sees the honest endpoint as lagging behind the best height…
    expect(transport.status().find((s) => s.id === 'honest')?.state).toBe('lagging');
    // …but a proof read asks both, so the liar alone never decides.
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).resolves.toBe('fact');
    expect(finCalls('liar')).toBe(1);
    expect(finCalls('honest')).toBe(1);
  });

  it('decides nothing when the liar disagrees with the honest endpoint', async () => {
    const { fake } = network({ liar: '1000000', honest: '100' }, { liar: 'forged' });
    const { transport, clock } = setup(
      [endpoint('liar', 0), endpoint('honest', 1)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('keeps honest endpoints in a proof read when one of three over-reports', async () => {
    const { fake, finCalls } = network({ liar: '1000000', a: '100', b: '100' });
    const { transport, clock } = setup(
      [endpoint('a', 0), endpoint('b', 1), endpoint('liar', 2)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b'), finCalls('liar')]).toEqual([1, 1, 0]);
  });

  it('decides nothing when lag leaves fewer endpoints than the quorum needs', async () => {
    const { fake, finCalls } = network({ a: '100', b: '100', c: '90' });
    const three = setup([endpoint('a'), endpoint('b'), endpoint('c')], fake, {
      maxLagBlocks: 5,
      proofQuorum: 3,
    });
    three.transport.setProbes(probes);
    await drive(three.clock, three.transport.refreshHealth());
    await expect(
      drive(three.clock, three.transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect([finCalls('a'), finCalls('b'), finCalls('c')]).toEqual([0, 0, 0]);
    // With a quorum of two, the two endpoints at the corroborated height serve it.
    const two = setup([endpoint('a'), endpoint('b'), endpoint('c')], fake, {
      maxLagBlocks: 5,
    });
    two.transport.setProbes(probes);
    await drive(two.clock, two.transport.refreshHealth());
    await expect(
      drive(two.clock, two.transport.rpc('fin', [], { quorum: 'proof' })),
    ).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b'), finCalls('c')]).toEqual([1, 1, 0]);
  });

  it("decides nothing while an honest endpoint's height is unknown, never letting the liar prove alone (A24)", async () => {
    // The review's E2: one failed honest height probe must not shrink the quorum.
    const { fake, finCalls } = network(
      { liar: '1000000', honest: 'down' },
      { liar: 'forged' },
    );
    const { transport, clock } = setup(
      [endpoint('liar', 0), endpoint('honest', 1)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(finCalls('liar')).toBe(0);
  });

  it('treats an endpoint whose height probe failed three refreshes in a row like an open breaker (A24)', async () => {
    const heights = { a: '100', b: 'down' };
    const { fake, finCalls } = network(heights);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    for (let refresh = 1; refresh <= 2; refresh++) {
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    // A sustained outage: after the third failed refresh in a row, b no longer counts.
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 0]);
    // Once b's height reads again, it counts and is asked again.
    heights.b = '100';
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([2, 1]);
  });

  it("measures a single proof read's lag against the corroborated height (M4)", async () => {
    const { fake, finCalls } = network(
      { honest: '100', liar: '1000000' },
      { liar: 'forged' },
    );
    const { transport, clock } = setup(
      [endpoint('honest', 0), endpoint('liar', 1)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('fin', [], { purpose: 'proof' })),
    ).resolves.toBe('fact');
    expect(finCalls('liar')).toBe(0);
  });

  // Pre-flight N1: a refresh that joined an identity check its request's caller then aborted
  // learned nothing about the endpoint (#4, round 4), so that refresh is no miss; only the
  // three genuine failed height probes after it stop b from counting.
  it('never counts a caller-aborted identity check toward the three misses (A24, N1)', async () => {
    let identityCalls = 0;
    const fake = new FakeFetch();
    for (const name of ['a', 'b']) {
      fake.route(`https://${name}.test`, (req, signal) => {
        if (method(req) === 'chain_id') {
          if (name === 'b' && ++identityCalls === 1) return hang(signal);
          return rpcResult(req, '1');
        }
        if (method(req) !== 'height') return rpcResult(req, 'fact');
        return name === 'a' ? rpcResult(req, '100') : { status: 503, text: '' };
      });
    }
    const finCalls = (name: string) =>
      fake
        .callsTo(`https://${name}.test`)
        .filter((call) => JSON.parse(call.body ?? '{}').method === 'fin').length;
    const { transport, clock } = setup([endpoint('b', 0), endpoint('a', 1)], fake);
    transport.setProbes({
      ...probes,
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    // A plain read starts b's first-use identity check; a refresh joins it; the read's caller
    // aborts it.
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const request = transport.rpc('x', [], { signal: controller.signal });
    await settle();
    const aborted = transport.refreshHealth();
    await settle();
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    await drive(clock, aborted);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    // Two genuine failed height probes: b (identity now confirmed) still counts.
    for (let refresh = 1; refresh <= 2; refresh++) {
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    expect(identityCalls).toBe(2);
    // The third genuine failure in a row is the sustained outage.
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 0]);
  });
});
