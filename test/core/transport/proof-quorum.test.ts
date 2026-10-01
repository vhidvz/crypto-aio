// Height exclusion must never shrink a quorum read, and one endpoint that over-reports
// its head must never become the only proof endpoint.
import type { EndpointCall, EndpointConfig } from '../../../src/core/transport/types';
import { drive, settle } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  hang,
  rpcError,
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

/** How many `rpcMethod` calls an endpoint received. */
const counter = (fake: FakeFetch, rpcMethod: string) => (name: string) =>
  fake
    .callsTo(`https://${name}.test`)
    .filter((call) => JSON.parse(call.body ?? '{}').method === rpcMethod).length;

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
  return { fake, finCalls: counter(fake, 'fin') };
}
const probes = {
  height: async (call: EndpointCall) => BigInt(await call.rpc<string>('height')),
};

/**
 * Endpoints answering the identity probe's `chain_id` from `ids` (read live; `'down'`
 * answers HTTP 503, `'hang'` never answers), the height probe from `heights` (default
 * '100') and every other request from `answers` (default 'fact'; read live, `'down'`
 * answers HTTP 503, `'refuse'` a definitive revert).
 */
function identified(
  ids: Record<string, string>,
  heights: Record<string, string> = {},
  answers: Record<string, string> = {},
) {
  const fake = new FakeFetch();
  for (const name of Object.keys(ids)) {
    fake.route(`https://${name}.test`, (req, signal) => {
      if (method(req) === 'chain_id') {
        if (ids[name] === 'down') return { status: 503, text: '' };
        return ids[name] === 'hang' ? hang(signal) : rpcResult(req, ids[name]);
      }
      if (method(req) === 'height') return rpcResult(req, heights[name] ?? '100');
      const answer = answers[name] ?? 'fact';
      if (answer === 'refuse') return rpcError(req, 3, 'execution reverted');
      return answer === 'down' ? { status: 503, text: '' } : rpcResult(req, answer);
    });
  }
  return { fake, finCalls: counter(fake, 'fin'), idCalls: counter(fake, 'chain_id') };
}
const identity = {
  identity: (call: EndpointCall) => call.rpc<string>('chain_id'),
  expectedIdentity: '1',
};
/** The default `healthIntervalMs`, which is also how long a failed identity probe throttles. */
const HEALTH_INTERVAL_MS = 15_000;

describe('proof quorum and height exclusion', () => {
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

  it("decides nothing while an honest endpoint's height is unknown, never letting the liar prove alone", async () => {
    // One failed honest height probe must not shrink the quorum.
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

  it('stops counting an endpoint whose height probe failed three refreshes in a row', async () => {
    const heights = { a: '100', b: 'down' };
    const { fake, finCalls } = network(heights);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    for (let refresh = 1; refresh <= 2; refresh++) {
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      // At most one miss counts per health interval.
      await clock.advance(HEALTH_INTERVAL_MS);
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

  it("measures a single proof read's lag against the corroborated height", async () => {
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

  // A refresh that joined an identity check its request's caller then aborted learned
  // nothing about the endpoint, so that refresh is no miss; only the three genuine failed
  // height probes after it stop b from counting.
  it('never counts a caller-aborted identity check toward the three misses', async () => {
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
    const finCalls = counter(fake, 'fin');
    const { transport, clock } = setup([endpoint('b', 0), endpoint('a', 1)], fake);
    transport.setProbes({ ...probes, ...identity });
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
    // Two genuine failed height probes, one health interval apart: b (identity now
    // confirmed) still counts.
    for (let refresh = 1; refresh <= 2; refresh++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    expect(identityCalls).toBe(2);
    // The third genuine failure in a row is the sustained outage.
    await clock.advance(HEALTH_INTERVAL_MS);
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 0]);
  });
});

// A quorum's size counts every endpoint not proven mismatched,
// verified or not, so one failed identity probe never leaves a verified liar alone. An
// unverified endpoint only counts; it never answers.
describe('proof quorum and unverified identities', () => {
  it("never lets an identity-verified liar prove alone after an honest endpoint's identity probe fails once", async () => {
    const { fake, finCalls } = identified(
      { liar: '1', honest: 'down' },
      { liar: '1000000' },
      { liar: 'forged' },
    );
    const { transport, clock } = setup(
      [endpoint('liar', 0), endpoint('honest', 1)],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes({ ...probes, ...identity });
    await drive(clock, transport.refreshHealth());
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(finCalls('liar')).toBe(0);
  });

  it('drops an endpoint from the count as soon as its identity is proven mismatched', async () => {
    const ids = { a: '1', m: 'down' };
    const { fake, finCalls } = identified(ids);
    const { transport, clock } = setup([endpoint('a'), endpoint('m')], fake);
    transport.setProbes({ ...probes, ...identity });
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await drive(clock, transport.refreshHealth());
    // m's identity is not known yet: it counts, so the proof decides nothing.
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    // m then proves to serve another network: it leaves the count at once, after one miss.
    ids.m = '2';
    await clock.advance(HEALTH_INTERVAL_MS);
    await drive(clock, transport.refreshHealth());
    expect(transport.status().find((s) => s.id === 'm')?.state).toBe('disabled');
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('m')]).toEqual([1, 0]);
  });

  it('drops an endpoint from the count once its identity probe fails three refreshes in a row', async () => {
    const ids = { a: '1', b: 'down' };
    const { fake, finCalls, idCalls } = identified(ids);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes({ ...probes, ...identity });
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    for (let refresh = 1; refresh <= 2; refresh++) {
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      // Past b's identity throttle, so the next refresh really probes it again.
      await clock.advance(HEALTH_INTERVAL_MS);
    }
    await drive(clock, transport.refreshHealth());
    expect(idCalls('b')).toBe(3);
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 0]);
    // Once b's identity is confirmed, it counts and is asked again.
    ids.b = '1';
    await clock.advance(HEALTH_INTERVAL_MS);
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([2, 1]);
  });

  it('decides nothing at startup rather than trusting whichever endpoint is verified first', async () => {
    const ids = { liar: '1', honest: 'hang' };
    const { fake, finCalls } = identified(ids, {}, { liar: 'forged' });
    const { transport, clock } = setup(
      [endpoint('liar', 0), endpoint('honest', 1)],
      fake,
      { timeoutMs: 1_000 },
    );
    // An identity probe alone: no height probe, so no height filter either.
    transport.setProbes(identity);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    // The first proof read runs the first refresh itself; honest's identity check times out.
    await expect(proof()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(finCalls('liar')).toBe(0);
    // Once honest is verified, both are asked, and the liar's answer is contradicted.
    ids.honest = '1';
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect([finCalls('liar'), finCalls('honest')]).toEqual([1, 1]);
  });

  // Request failures that open an honest endpoint's breaker never shrink the count
  // either; an open breaker only stops the endpoint answering.
  it("never lets a verified liar prove alone while an honest endpoint's breaker is open", async () => {
    const answers: Record<string, string> = { honest: 'down', liar: 'forged' };
    const { fake, finCalls } = identified(
      { honest: '1', liar: '1' },
      { liar: '1000000' },
      answers,
    );
    const openMs = 30_000;
    const { transport, clock } = setup(
      [endpoint('honest', 0), endpoint('liar', 1)],
      fake,
      { maxLagBlocks: 5, failureThreshold: 2, openMs },
    );
    transport.setProbes({ ...probes, ...identity });
    await drive(clock, transport.refreshHealth());
    // Two plain reads fail on honest and fail over to the liar: honest's breaker opens.
    for (let read = 1; read <= 2; read++) await drive(clock, transport.rpc('x'));
    expect(transport.status().find((s) => s.id === 'honest')?.state).toBe('open');
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await expect(proof()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(finCalls('liar')).toBe(0);
    // honest recovers: its half-open breaker lets the proof through, and its answer closes
    // the breaker and contradicts the liar's.
    answers.honest = 'fact';
    await clock.advance(openMs);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect([finCalls('honest'), finCalls('liar')]).toEqual([1, 1]);
    // With its breaker closed, honest is back in service for every proof read.
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect([finCalls('honest'), finCalls('liar')]).toEqual([2, 2]);
  });
});

// Counting endpoints that cannot answer must never stall proofs for good (a dead
// endpoint leaves the count after three spaced misses, whatever probes are configured), and
// misses are spaced in time, so frequent refreshes never turn a hiccup into exclusion.
describe('proof quorum health misses', () => {
  it('counts at most one miss per health interval, so rapid refreshes never leave the liar alone', async () => {
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
    // Three refreshes at the same instant (a caller polling refreshHealth or
    // getNetworkStatus) are one miss, not a sustained outage.
    for (let refresh = 1; refresh <= 3; refresh++) {
      await drive(clock, transport.refreshHealth());
    }
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(finCalls('liar')).toBe(0);
  });

  it('drops a dead endpoint after three spaced misses with an identity probe alone', async () => {
    const ids = { a: '1', b: '1' };
    const answers: Record<string, string> = {};
    const { fake, idCalls } = identified(ids, {}, answers);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(identity);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await expect(proof()).resolves.toBe('fact');
    // b dies after its identity was confirmed: its probe and its requests fail from now on.
    ids.b = 'down';
    answers.b = 'down';
    for (let miss = 1; miss <= 2; miss++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(proof()).resolves.toBe('fact');
    // Each refresh re-probed b's confirmed identity, its only health signal.
    expect(idCalls('b')).toBe(4);
  });

  it("sizes a proof quorum read under purpose 'read' the same way (token metadata)", async () => {
    const { fake, finCalls } = identified(
      { honest: '1', liar: '1' },
      { liar: '1000000' },
      { honest: 'down', liar: 'forged' },
    );
    const { transport, clock } = setup(
      [endpoint('honest', 0), endpoint('liar', 1)],
      fake,
      { maxLagBlocks: 5, failureThreshold: 2 },
    );
    transport.setProbes({ ...probes, ...identity });
    await drive(clock, transport.refreshHealth());
    for (let read = 1; read <= 2; read++) await drive(clock, transport.rpc('x'));
    expect(transport.status().find((s) => s.id === 'honest')?.state).toBe('open');
    await expect(
      drive(clock, transport.rpc('fin', [], { purpose: 'read', quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(finCalls('liar')).toBe(0);
  });

  it("refreshes health for a proof quorum read under purpose 'read', so a dead endpoint still leaves", async () => {
    const ids = { a: '1', b: '1' };
    const answers: Record<string, string> = {};
    const { fake } = identified(ids, {}, answers);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(identity);
    const metadata = () =>
      drive(clock, transport.rpc('fin', [], { purpose: 'read', quorum: 'proof' }));
    await expect(metadata()).resolves.toBe('fact');
    ids.b = 'down';
    answers.b = 'down';
    for (let miss = 1; miss <= 2; miss++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await expect(metadata()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(metadata()).resolves.toBe('fact');
  });

  it('counts only usable endpoints when no probe is configured, so proofs never stall', async () => {
    const { fake, finCalls } = identified({ a: '1', b: '1' }, {}, { b: 'down' });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake, {
      failureThreshold: 1,
    });
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    // The weaker, prior rule: once b's breaker opens, b no longer counts.
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([2, 1]);
  });

  it('counts only usable endpoints when no refresh can see a dead endpoint', async () => {
    const { fake, finCalls } = identified({ a: '1', b: '1' }, {}, { b: 'down' });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake, {
      failureThreshold: 1,
    });
    // An identity probe without an expected identity checks nothing, and there is no height
    // probe: a refresh does no I/O, so no miss is ever recorded.
    transport.setProbes({ identity: identity.identity });
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([2, 1]);
  });

  it("never counts a joined identity check that a request's shorter deadline ended", async () => {
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
    const finCalls = counter(fake, 'fin');
    const { transport, clock } = setup([endpoint('b', 0), endpoint('a', 1)], fake);
    transport.setProbes({ ...probes, ...identity });
    // A read with a short timeout starts b's first-use identity check, a refresh joins it,
    // and the read's own deadline ends it long before the refresh's: not a miss.
    const request = transport.rpc('x', [], { timeoutMs: 50 });
    await settle();
    const joined = transport.refreshHealth();
    await settle();
    await expect(drive(clock, request)).resolves.toBe('fact');
    await drive(clock, joined);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    // Two genuine failed refreshes, one health interval apart (past b's identity throttle):
    // b (identity now confirmed, height unreadable) still counts.
    for (let refresh = 1; refresh <= 2; refresh++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await drive(clock, transport.refreshHealth());
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    expect(identityCalls).toBe(2);
    await clock.advance(HEALTH_INTERVAL_MS);
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 0]);
  });
});

// An endpoint whose probes answer but whose requests fail (its breaker not closed, or its
// failures in a row at the breaker's threshold) records a health miss instead of a reset,
// so it leaves the count after three spaced misses, as a probe-dead one does, while a
// shorter open breaker still counts.
describe('proof quorum and request-dead endpoints', () => {
  it('recovers proofs within about three health intervals of an endpoint failing every request', async () => {
    // The reproduction of a request-dead endpoint: both endpoints answer the height
    // probe, b answers HTTP 503 to every proof read, and a proof read runs every 20 s for
    // 20 minutes.
    const { fake, finCalls } = identified({ a: '1', b: '1' }, {}, { b: 'down' });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    const outcomes: string[] = [];
    for (let read = 0; read < 60; read++) {
      if (read > 0) await clock.advance(20_000);
      outcomes.push(
        await drive(clock, transport.rpc('fin', [], { quorum: 'proof' })).then(
          (value) => String(value),
          (error: { code: string }) => error.code,
        ),
      );
    }
    // Five failures open b's breaker (80 s); the refreshes at 100, 120 and 140 s find it not
    // closed and record its three misses; from 140 s on, b no longer counts.
    expect(outcomes.slice(0, 7)).toEqual(Array(7).fill('PROVIDER_UNAVAILABLE'));
    expect(outcomes.slice(7)).toEqual(Array(53).fill('fact'));
    // a missed only the read that failed fast while b's breaker was open (100 s). b was asked
    // until it left the count (6 times); after that, a trial tries it once per half-open
    // window (every other read: each failed trial reopens its breaker for 30 s), 26 times,
    // and the failed trials never touch the verdict.
    expect([finCalls('a'), finCalls('b')]).toEqual([59, 32]);
  });

  it('keeps counting a breaker open for under three health intervals, one miss per interval', async () => {
    const { fake, finCalls } = identified(
      { honest: '1', liar: '1' },
      {},
      { honest: 'down', liar: 'forged' },
    );
    const { transport, clock } = setup(
      [endpoint('honest', 0), endpoint('liar', 1)],
      fake,
      { failureThreshold: 2, openMs: 10 * 60_000 },
    );
    transport.setProbes({ ...probes, ...identity });
    await drive(clock, transport.refreshHealth());
    // Two plain reads fail on honest and fail over to the liar: honest's breaker opens.
    for (let read = 1; read <= 2; read++) await drive(clock, transport.rpc('x'));
    expect(transport.status().find((s) => s.id === 'honest')?.state).toBe('open');
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    // Two health intervals of an open breaker, each refreshed three times at one instant, are
    // two misses: honest still counts, and the liar never proves alone.
    for (let interval = 1; interval <= 2; interval++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      for (let refresh = 1; refresh <= 3; refresh++) {
        await drive(clock, transport.refreshHealth());
      }
      await expect(proof()).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }
    expect(finCalls('liar')).toBe(0);
    // The third interval makes it a sustained request outage: honest no longer counts. With
    // two endpoints the other then proves alone, the documented cost (use three or more).
    await clock.advance(HEALTH_INTERVAL_MS);
    await drive(clock, transport.refreshHealth());
    await expect(proof()).resolves.toBe('forged');
  });

  it('counts an endpoint again once it serves requests and a later refresh succeeds', async () => {
    const answers: Record<string, string> = { honest: 'down', liar: 'forged' };
    const { fake, finCalls } = identified({ honest: '1', liar: '1' }, {}, answers);
    const openMs = 60_000;
    const { transport, clock } = setup(
      [endpoint('honest', 0), endpoint('liar', 1)],
      fake,
      { failureThreshold: 2, openMs },
    );
    transport.setProbes({ ...probes, ...identity });
    await drive(clock, transport.refreshHealth());
    for (let read = 1; read <= 2; read++) await drive(clock, transport.rpc('x'));
    for (let interval = 1; interval <= 3; interval++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await drive(clock, transport.refreshHealth());
    }
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    await expect(proof()).resolves.toBe('forged');
    // honest serves again. Once its breaker is half-open it is tried alongside the liar:
    // its answer blocks the liar's at once and closes its breaker…
    answers.honest = 'fact';
    await clock.advance(openMs);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    // …and the next refresh that finds it serving resets its misses: it counts again, so the
    // liar is contradicted instead of proving alone.
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect([finCalls('honest'), finCalls('liar')]).toEqual([2, 3]);
  });
});

// An endpoint out of the count whose breaker is half-open is tried alongside the
// counted endpoints. Its answer can only block a proof (a disagreement or a refusal decides
// nothing); an agreeing answer closes its breaker, so it rejoins at the next refresh.
describe('proof quorum trials of a recovering endpoint', () => {
  const OPEN_MS = 60_000;

  /**
   * a and b at equal priority with a height probe. b fails every request until its breaker
   * opens and three spaced refreshes drop it from the count (a then proves alone); then it
   * answers `recovered` and its breaker turns half-open. Answers (read live): 'down' (HTTP
   * 503), 'refuse' (a revert), 'hang' (never, until aborted), 'slow:<value>' (the value
   * after 5 s) or a value. Every request to b is logged with its time.
   */
  async function recovering(recovered: string, b: Partial<EndpointConfig> = {}) {
    const answers: Record<string, string> = { b: 'down' };
    const log: { readonly method: string; readonly at: number }[] = [];
    let now = () => 0;
    let sleep = (_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve();
    const fake = new FakeFetch();
    for (const name of ['a', 'b']) {
      fake.route(`https://${name}.test`, (req, signal) => {
        if (name === 'b') log.push({ method: method(req), at: now() });
        if (method(req) === 'height') return rpcResult(req, '100');
        const answer = answers[name] ?? 'fact';
        if (answer === 'refuse') return rpcError(req, 3, 'execution reverted');
        if (answer === 'hang') return hang(signal);
        if (answer.startsWith('slow:')) {
          return sleep(5_000, signal).then(() => rpcResult(req, answer.slice(5)));
        }
        return answer === 'down' ? { status: 503, text: '' } : rpcResult(req, answer);
      });
    }
    const { transport, clock, seen } = setup(
      [endpoint('a'), { ...endpoint('b'), ...b }],
      fake,
      { failureThreshold: 2, openMs: OPEN_MS },
    );
    now = () => clock.now();
    sleep = (ms, signal) => clock.sleep(ms, signal);
    transport.setProbes(probes);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    // Two proof reads fail on b while it still counts: its breaker opens.
    for (let read = 1; read <= 2; read++) {
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    // Three spaced refreshes find it open: it leaves the count, and a proves alone.
    for (let refresh = 1; refresh <= 3; refresh++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await drive(clock, transport.refreshHealth());
    }
    await expect(proof()).resolves.toBe('fact');
    answers.b = recovered;
    await clock.advance(OPEN_MS);
    const bCalls = () => log.filter((request) => request.method === 'fin').length;
    return { transport, clock, seen, proof, answers, log, bCalls };
  }

  it('lets a recovered endpoint rejoin through a trial, even at equal priority', async () => {
    // The reproduction above, then b recovers.
    const answers: Record<string, string> = { b: 'down' };
    const { fake, finCalls } = identified({ a: '1', b: '1' }, {}, answers);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    const proof = () =>
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })).then(
        (value) => String(value),
        (error: { code: string }) => error.code,
      );
    for (let read = 0; read < 8; read++) {
      if (read > 0) await clock.advance(20_000);
      await proof();
    }
    // b left the count at 140 s: a proves alone.
    expect(await proof()).toBe('fact');
    // b recovers. At 160 s its breaker is half-open: it is tried alongside a, and its
    // agreeing answer closes the breaker…
    answers.b = 'fact';
    const before = finCalls('b');
    await clock.advance(20_000);
    expect(await proof()).toBe('fact');
    expect(finCalls('b')).toBe(before + 1);
    // …so the refresh at 180 s counts it again, and every proof asks both.
    await clock.advance(20_000);
    expect(await proof()).toBe('fact');
    expect(finCalls('b')).toBe(before + 2);
    // A lone lying a can no longer prove.
    answers.a = 'forged';
    await clock.advance(20_000);
    expect(await proof()).toBe('PROVIDER_INCONSISTENT');
  });

  it("blocks the proof when the recovering endpoint's answer disagrees", async () => {
    const { proof, bCalls, seen } = await recovering('other');
    const before = bCalls();
    await expect(proof()).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    expect(bCalls()).toBe(before + 1);
    expect(seen.filter((e) => e.type === 'provider.inconsistent')).toHaveLength(1);
  });

  it('blocks the proof when the recovering endpoint refuses while a answers', async () => {
    const { proof, bCalls } = await recovering('refuse');
    const before = bCalls();
    await expect(proof()).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    expect(bCalls()).toBe(before + 1);
  });

  it('leaves the verdict to the counted endpoints when the trial fails in transport', async () => {
    const { proof, bCalls, transport, clock, log } = await recovering('down');
    const before = bCalls();
    await expect(proof()).resolves.toBe('fact');
    expect(bCalls()).toBe(before + 1);
    // The failure counts against b as usual: its breaker opens again, and it stays out. A
    // failed trial forces no refresh: the next read probes nothing.
    expect(transport.status().find((s) => s.id === 'b')?.state).toBe('open');
    const probed = log.length - bCalls();
    await expect(proof()).resolves.toBe('fact');
    expect(log.length - bCalls()).toBe(probed);
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(proof()).resolves.toBe('fact');
    expect(bCalls()).toBe(before + 1);
  });

  it('skips a trial whose rate-limit token is not free, without waiting', async () => {
    const { transport, clock, answers, bCalls } = await recovering('fact', {
      rateLimit: { rps: 1, burst: 1 },
    });
    answers.a = 'forged';
    // A proof read with a 500 ms timeout.
    const proof = () =>
      drive(clock, transport.rpc('fin', [], { quorum: 'proof', timeoutMs: 500 }));
    const before = bCalls();
    // The refresh this read runs first takes b's only token: the trial is skipped at once,
    // and a decides alone (the documented cost while b is out), with no wait.
    const started = clock.now();
    await expect(proof()).resolves.toBe('forged');
    expect(clock.now() - started).toBe(0);
    expect(bCalls()).toBe(before);
    // A second later b's bucket has a token again: the trial goes out and blocks the liar.
    await clock.advance(1_000);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect(bCalls()).toBe(before + 1);
  });

  it("keeps a trial's veto: the next proof read refreshes health first", async () => {
    // b answers honestly while a lies; or b refuses while a answers.
    for (const [recovered, a] of [
      ['fact', 'forged'],
      ['refuse', 'fact'],
    ] as const) {
      const { proof, answers, clock, log, bCalls } = await recovering(recovered);
      answers.a = a;
      const heights = () => log.length - bCalls();
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
      // The trial closed b's breaker. A prompt retry refreshes health first, which counts b
      // again, so it never lets a decide alone…
      const probed = heights();
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
      expect(heights()).toBe(probed + 1);
      // …and later reads within the health interval keep counting it, with no refresh.
      await clock.advance(HEALTH_INTERVAL_MS - 1);
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
      expect(heights()).toBe(probed + 1);
    }
  });

  // The trial's own answer (or refusal) makes health due, whatever becomes of the
  // counted endpoints' read: a failure, an abort or a slow answer never reopens the gap.
  describe('the veto holds whatever becomes of the read carrying the trial', () => {
    it('when a fails that read', async () => {
      const { proof, answers, bCalls } = await recovering('fact');
      const before = bCalls();
      answers.a = 'down';
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(bCalls()).toBe(before + 1);
      answers.a = 'forged';
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    });

    it('when the caller aborts that read after the trial answered', async () => {
      const { transport, clock, proof, answers, bCalls } = await recovering('fact');
      const before = bCalls();
      answers.a = 'hang';
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const read = transport.rpc('fin', [], {
        quorum: 'proof',
        signal: controller.signal,
      });
      await settle();
      expect(bCalls()).toBe(before + 1);
      controller.abort(reason);
      await expect(drive(clock, read)).rejects.toBe(reason);
      answers.a = 'forged';
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    });

    it('for a read that starts while a is still answering that read', async () => {
      const { transport, clock, answers, bCalls } = await recovering('fact');
      const before = bCalls();
      answers.a = 'slow:forged';
      const read = () =>
        transport.rpc('fin', [], { quorum: 'proof' }).then(
          (value) => String(value),
          (error: { code: string }) => error.code,
        );
      const first = read();
      await settle();
      expect(bCalls()).toBe(before + 1);
      // One second later b's breaker is closed but b is not yet counted.
      await clock.advance(1_000);
      const second = read();
      expect(await drive(clock, Promise.all([first, second]))).toEqual([
        'PROVIDER_INCONSISTENT',
        'PROVIDER_INCONSISTENT',
      ]);
    });
  });

  it('tries a recovering endpoint even when no counted endpoint can answer', async () => {
    const answers: Record<string, string> = { a: 'down', b: 'down' };
    const { fake, finCalls } = identified({ a: '1', b: '1' }, {}, answers);
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake, {
      failureThreshold: 2,
      openMs: OPEN_MS,
    });
    transport.setProbes(probes);
    const proof = () => drive(clock, transport.rpc('fin', [], { quorum: 'proof' }));
    for (let read = 1; read <= 2; read++) {
      await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
    for (let refresh = 1; refresh <= 3; refresh++) {
      await clock.advance(HEALTH_INTERVAL_MS);
      await drive(clock, transport.refreshHealth());
    }
    // Both are out of the count; b recovers, and both breakers turn half-open. No endpoint
    // counts, so each proof decides nothing, but one trial per read still goes out: a first
    // (by name), which fails and reopens, then b, which answers and closes its breaker.
    answers.b = 'fact';
    await clock.advance(OPEN_MS);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect([finCalls('a'), finCalls('b')]).toEqual([3, 2]);
    await expect(proof()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect([finCalls('a'), finCalls('b')]).toEqual([3, 3]);
    // The next refresh counts b again, and b answers for the quorum.
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(proof()).resolves.toBe('fact');
    expect([finCalls('a'), finCalls('b')]).toEqual([3, 4]);
  });
});

// Under a proof quorum, one endpoint's definitive error decides only when the quorum's
// endpoints all return an equivalent one (the same code, HTTP status and rpcCode, and for
// an implementation-defined rpcCode the same text); otherwise the read decides nothing,
// and the other endpoints are still asked.
describe('proof quorum and definitive errors', () => {
  const REVERT = { code: 3, message: 'execution reverted' };
  /** Endpoints at height 100 answering 'fin' with `replies`: a JSON-RPC error or a result. */
  function refusing(replies: Record<string, { code: number; message: string } | string>) {
    const fake = new FakeFetch();
    for (const [name, reply] of Object.entries(replies)) {
      fake.route(`https://${name}.test`, (req) => {
        if (method(req) === 'height') return rpcResult(req, '100');
        return typeof reply === 'string'
          ? rpcResult(req, reply)
          : rpcError(req, reply.code, reply.message);
      });
    }
    return { fake, finCalls: counter(fake, 'fin') };
  }

  it("never lets one endpoint's revert decide against an honest answer", async () => {
    for (const shape of [
      { quorum: 'proof' },
      { purpose: 'read', quorum: 'proof' },
    ] as const) {
      const { fake, finCalls } = refusing({ liar: REVERT, honest: 'fact' });
      const { transport, clock, seen } = setup(
        [endpoint('liar', 0), endpoint('honest', 1)],
        fake,
      );
      transport.setProbes(probes);
      await expect(drive(clock, transport.rpc('fin', [], shape))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
      expect([finCalls('liar'), finCalls('honest')]).toEqual([1, 1]);
      expect(seen.filter((e) => e.type === 'provider.inconsistent')).toHaveLength(1);
    }
  });

  it('decides a definitive error the whole quorum returns alike', async () => {
    const { fake, finCalls } = refusing({ a: REVERT, b: REVERT });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: false });
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 1]);
  });

  it('decides nothing when the definitive errors differ', async () => {
    const { fake, finCalls } = refusing({
      a: REVERT,
      b: { code: -32000, message: 'header not found' },
    });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    transport.setProbes(probes);
    await expect(
      drive(clock, transport.rpc('fin', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    expect([finCalls('a'), finCalls('b')]).toEqual([1, 1]);
  });

  // Equivalent means the same code, HTTP status and JSON-RPC code, and for an
  // implementation-defined JSON-RPC code, the same message text.
  it('tells REST refusals apart by their HTTP status', async () => {
    const rest = (statuses: Record<string, number>) => {
      const fake = new FakeFetch();
      for (const [name, status] of Object.entries(statuses)) {
        fake.route(`https://${name}.test`, () => ({ status, text: '{"error":"no"}' }));
      }
      return setup([endpoint('a'), endpoint('b')], fake);
    };
    const read = { method: 'GET', path: '/account' } as const;
    const unlike = rest({ a: 404, b: 400 });
    await expect(
      drive(unlike.clock, unlike.transport.http(read, { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    const alike = rest({ a: 404, b: 404 });
    await expect(
      drive(alike.clock, alike.transport.http(read, { quorum: 'proof' })),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
      details: { status: 404 },
    });
  });

  it('tells implementation-defined JSON-RPC errors apart by their text, and others by code', async () => {
    const TEXTS = ['execution reverted', 'header not found'] as const;
    const outcome = async (code: number, messages: readonly [string, string]) => {
      const { fake } = refusing({
        a: { code, message: messages[0] },
        b: { code, message: messages[1] },
      });
      const { transport, clock, seen } = setup([endpoint('a'), endpoint('b')], fake);
      transport.setProbes(probes);
      const error = await drive(
        clock,
        transport.rpc('fin', [], { quorum: 'proof' }),
      ).catch((e: unknown) => e);
      return { error, seen };
    };
    // -32000 to -32099 and -32603: each implementation defines what the code means.
    for (const code of [-32000, -32050, -32099, -32603]) {
      const { error, seen } = await outcome(code, TEXTS);
      expect(error).toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      // Comparing the texts puts neither into the error or an event.
      for (const text of TEXTS) {
        expect(JSON.stringify(error)).not.toContain(text);
        expect(JSON.stringify(seen)).not.toContain(text);
      }
      const alike = await outcome(code, [TEXTS[1], TEXTS[1]]);
      expect(alike.error).toMatchObject({
        code: 'RPC_ERROR',
        retryable: false,
        details: { rpcCode: code, rpcMessage: TEXTS[1] },
      });
    }
    // A standard code (and one just outside that range) means the same whatever the text.
    for (const code of [-32602, -32100]) {
      const { error } = await outcome(code, ['invalid params', 'missing argument 0']);
      expect(error).toMatchObject({ code: 'RPC_ERROR', details: { rpcCode: code } });
    }
  });
});
