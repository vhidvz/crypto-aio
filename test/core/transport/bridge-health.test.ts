import { inspect } from 'node:util';
import {
  PLACEHOLDER_ORIGIN,
  type EndpointCall,
  type EndpointConfig,
} from '../../../src/core/transport/types';
import { drive, settle } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  hang,
  rpcResult,
  type FakeRequest,
} from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const method = (req: FakeRequest) => req.json<{ method: string }>().method;

// Fix round 1, group C: the createFetch bridge and health-refresh concurrency
// (controller ruling R14, task-15-fix-1.md items I1, I8, M5).
describe('HttpTransport bridge', () => {
  // I1: the bridged Response's `url` must never leak the real endpoint URL.
  it('never exposes the real endpoint url through the bridged Response', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', () => {
      const response = new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', {
        value: 'https://real.host/v1/sk_live_SECRET',
      });
      return response;
    });
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
    );
    const bridged = transport.createFetch();
    const response = await drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`));
    expect(response.url).toBe('');
    expect(inspect(response)).not.toContain('sk_live_SECRET');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  // I1: a body that never finishes must time out, not hang forever.
  it('times out a body read that never finishes within timeoutMs of fake time', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', (_req, signal) => {
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
      {
        timeoutMs: 1_000,
        maxAttempts: 1,
      },
    );
    const bridged = transport.createFetch();
    const start = clock.now();
    const error = await drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`), 100).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(clock.now() - start).toBeLessThanOrEqual(1_000);
  });

  // #1 (round 3): a bad SDK-supplied header value must be rejected before #run is even
  // entered — no fetch, no breaker bookkeeping, no ambiguity tagging.
  it('rejects an invalid SDK header value before touching any endpoint', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', (req) =>
      rpcResult(req, 'x'),
    );
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
    );
    const bridged = transport.createFetch();
    const error = await drive(
      clock,
      bridged(`${PLACEHOLDER_ORIGIN}/`, { headers: { 'x-bad': 'a\u0000b' } }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      retryable: false,
      ambiguous: false,
    });
    expect(fake.calls).toHaveLength(0);
    expect(transport.status()[0]?.failures).toBe(0);
  });

  // #3 (round 4): the whole Request is built once before #run — a GET with a body (which
  // fetch itself would reject) is a local config error, never an endpoint failure.
  it('rejects a GET with a body before touching any endpoint', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', (req) =>
      rpcResult(req, 'x'),
    );
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
    );
    const bridged = transport.createFetch();
    const error = await drive(
      clock,
      bridged(`${PLACEHOLDER_ORIGIN}/`, { method: 'GET', body: '{"x":1}' }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      retryable: false,
      ambiguous: false,
    });
    expect(fake.calls).toHaveLength(0);
    expect(transport.status()[0]).toMatchObject({ failures: 0, state: 'unknown' });
  });

  // M5: a Request input keeps its own method, headers and body.
  it('keeps a Request input method, headers and body', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', (req) => ({
      json: {
        method: req.method,
        auth: req.headers.get('authorization'),
        body: req.body,
      },
    }));
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
    );
    const bridged = transport.createFetch();
    const request = new Request(`${PLACEHOLDER_ORIGIN}/`, {
      method: 'POST',
      headers: { authorization: 'Bearer xyz' },
      body: '{"x":1}',
    });
    const response = await drive(clock, bridged(request));
    await expect(response.json()).resolves.toEqual({
      method: 'POST',
      auth: 'Bearer xyz',
      body: '{"x":1}',
    });
  });

  // M5: a relative or otherwise invalid URL is CONFIG_INVALID, and never echoes the input.
  it('rejects a relative or invalid URL without leaking the input', async () => {
    const fake = new FakeFetch();
    const { transport } = setup([{ name: 's', url: 'https://sol.test/rpc' }], fake);
    const bridged = transport.createFetch();
    const error = await bridged('/not-absolute').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain('/not-absolute');
  });

  // M5: a 5xx response body is never returned to the SDK; it's cancelled instead of leaked.
  it('cancels a 5xx response body instead of leaking the stream', async () => {
    let cancelled = false;
    const fake = new FakeFetch().route('https://sol.test/rpc', () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('server error'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 503 });
    });
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
      {
        maxAttempts: 1,
      },
    );
    const bridged = transport.createFetch();
    await expect(drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(cancelled).toBe(true);
  });

  // N1: statuses 101/103/204/205/304 must never carry a body on the Response constructed
  // for the SDK — the Response constructor throws if they do.
  it('returns status 204 and 304 responses correctly after exactly 1 fetch', async () => {
    for (const status of [204, 304] as const) {
      const fake = new FakeFetch().route(
        'https://sol.test/rpc',
        () => new Response(null, { status }),
      );
      const { transport, clock } = setup(
        [{ name: 's', url: 'https://sol.test/rpc' }],
        fake,
      );
      const bridged = transport.createFetch();
      const response = await drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`));
      expect(response.status).toBe(status);
      expect(fake.calls).toHaveLength(1);
    }
  });

  // #10: content-encoding/content-length describe the original wire body, not the
  // already-decoded buffer handed to the SDK — they must not be copied across.
  it('drops content-encoding and content-length from the bridged response headers', async () => {
    const fake = new FakeFetch().route(
      'https://sol.test/rpc',
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '999',
          },
        }),
    );
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
    );
    const bridged = transport.createFetch();
    const response = await drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`));
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  // #7: a rejecting response.body.cancel() must never surface as an unhandled rejection.
  it('never leaves an unhandled rejection when the response body fails to cancel', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('server error'));
        },
        cancel() {
          return Promise.reject(new Error('cancel failed'));
        },
      });
      return new Response(body, { status: 503 });
    });
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
      { maxAttempts: 1 },
    );
    const bridged = transport.createFetch();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`))).rejects.toMatchObject(
        {
          code: 'PROVIDER_UNAVAILABLE',
        },
      );
      await settle();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });

  // M5: a 401 response body is likewise cancelled, not leaked.
  it('cancels a 401 response body instead of leaking the stream', async () => {
    let cancelled = false;
    const fake = new FakeFetch().route('https://sol.test/rpc', () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('unauthorized'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 401 });
    });
    const { transport, clock } = setup(
      [{ name: 's', url: 'https://sol.test/rpc' }],
      fake,
      {
        maxAttempts: 1,
      },
    );
    const bridged = transport.createFetch();
    await expect(drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/`))).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
    });
    expect(cancelled).toBe(true);
  });
});

describe('HttpTransport health refresh concurrency', () => {
  // I8 (round 2, item 1): rewritten so the lagging endpoint sits at priority 0 and the height
  // probe only resolves after the fake clock advances — so if a caller could slip past the
  // shared in-flight refresh (the pre-round-1 bug), it would race ahead on stale/unset height
  // data and route to the lagging endpoint by priority alone. Two concurrent monitor reads
  // must both be served by the non-lagging endpoint regardless.
  it('serves two concurrent monitor reads from a single health refresh', async () => {
    const heights: Record<string, string> = { a: '100', b: '90' };
    let heightCalls = 0;
    const handler = (name: string) => (req: FakeRequest) => {
      if (method(req) === 'height') heightCalls++;
      return rpcResult(req, method(req) === 'height' ? heights[name] : name);
    };
    const fake = new FakeFetch()
      .route('https://a.test', handler('a'))
      .route('https://b.test', handler('b'));
    const { transport, clock } = setup(
      [
        { ...B, priority: 0 }, // B is lagging (height 90) but placed first by priority
        { ...A, priority: 1 }, // A is the non-lagging endpoint (height 100)
      ],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes({
      height: async (call) => {
        await clock.sleep(50); // resolves only once the fake clock is advanced
        return BigInt(await call.rpc<string>('height'));
      },
    });
    const [r1, r2] = await drive(
      clock,
      Promise.all([
        transport.rpc('x', [], { purpose: 'monitor' }),
        transport.rpc('x', [], { purpose: 'monitor' }),
      ]),
    );
    expect(r1).toBe('a');
    expect(r2).toBe('a');
    // One height probe per endpoint: the second caller joined the in-flight refresh instead
    // of starting its own.
    expect(heightCalls).toBe(2);
  });

  // R18 / item 2 (round 3): #refresh never does breaker bookkeeping — not for a throttled
  // identity probe it skips, and not even for a genuine (non-throttled) probe failure.
  it('never counts an identity-probe failure or throttle hit against the breaker in #refresh', async () => {
    let identityCalls = 0;
    const fake = new FakeFetch().route('https://a.test', () => {
      identityCalls++;
      return { status: 503, text: '' };
    });
    const { transport, clock } = setup([A], fake, { healthIntervalMs: 60_000 });
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await drive(clock, transport.refreshHealth());
    await drive(clock, transport.refreshHealth());
    await drive(clock, transport.refreshHealth());
    // Only the first refresh actually probed; the other two saw the still-throttled identity
    // and skipped it.
    expect(identityCalls).toBe(1);
    expect(transport.status()[0]?.failures).toBe(0);
  });

  // #9 (round 2): a probe that ignores its own abort signal must not hang the refresh
  // forever — it's raced against the deadline instead, so #healthRun always settles.
  it('settles the refresh within timeoutMs when a height probe never answers, and concurrent readers proceed', async () => {
    const { transport, clock } = setup([A], new FakeFetch(), { timeoutMs: 1_000 });
    transport.setProbes({
      height: () => new Promise<bigint>(() => undefined),
    });
    const start = clock.now();
    const [r1, r2] = await drive(
      clock,
      Promise.allSettled([transport.refreshHealth(), transport.refreshHealth()]),
      100,
    );
    expect(clock.now() - start).toBeLessThanOrEqual(1_000);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
  });

  // #3 (round 3): a fully-failed refresh must not be re-attempted on every read during an
  // outage — it backs off to min(healthIntervalMs, 1000) instead of a probe storm.
  it('backs off outage re-probing instead of storming on every monitor read', async () => {
    let heightCallsA = 0;
    let heightCallsB = 0;
    const fake = new FakeFetch()
      .route('https://a.test', (req) => {
        if (method(req) === 'height') heightCallsA++;
        return { status: 503, text: '' };
      })
      .route('https://b.test', (req) => {
        if (method(req) === 'height') heightCallsB++;
        return { status: 503, text: '' };
      });
    const { transport, clock } = setup([A, B], fake, { healthIntervalMs: 60_000 });
    transport.setProbes({
      height: async (call) => BigInt(await call.rpc<string>('height')),
    });
    for (let i = 0; i < 10; i++) {
      await expect(
        drive(clock, transport.rpc('x', [], { purpose: 'monitor' }), 50),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
    expect(heightCallsA).toBeLessThanOrEqual(2);
    expect(heightCallsB).toBeLessThanOrEqual(2);

    await clock.advance(1_000);
    const beforeA = heightCallsA;
    const beforeB = heightCallsB;
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' }), 50),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(heightCallsA).toBeGreaterThan(beforeA);
    expect(heightCallsB).toBeGreaterThan(beforeB);
  });

  // I8 (round 2, item 1): a single transient height-probe failure must not block monitor
  // reads for a full healthIntervalMs — the next read re-probes instead of trusting a
  // fully-failed refresh as fresh.
  it('re-probes on the next read after a transient height-probe failure instead of blocking for healthIntervalMs', async () => {
    let heightCalls = 0;
    const fake = new FakeFetch().route('https://a.test', (req) => {
      if (method(req) === 'height') {
        heightCalls++;
        return heightCalls === 1 ? { status: 503, text: '' } : rpcResult(req, '100');
      }
      return rpcResult(req, 'from-a');
    });
    const { transport, clock } = setup([A], fake, { healthIntervalMs: 60_000 });
    transport.setProbes({
      height: async (call) => BigInt(await call.rpc<string>('height')),
    });
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    // #3 (round 3): a fully-failed refresh now backs off for min(healthIntervalMs, 1000)ms
    // before the next re-probe (outage-storm guard), rather than re-probing on the very next
    // read; advance past that window so this still proves "not blocked for the full
    // healthIntervalMs" rather than "blocked for 0ms".
    await clock.advance(1_000);
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('from-a');
    expect(heightCalls).toBe(2);
  });

  // #4 (round 4): a refresh that joined a request-path identity check which its own caller
  // then aborted learned nothing about the endpoint — that counts as not attempted, so it
  // must not arm the outage backoff, and the next monitor read re-probes.
  it('re-probes on the next monitor read after a caller aborts a joined identity check', async () => {
    let identityCalls = 0;
    const fake = new FakeFetch().route('https://a.test', (req, signal) => {
      if (method(req) === 'chain_id') {
        identityCalls++;
        return identityCalls === 1 ? hang(signal) : rpcResult(req, '1');
      }
      return rpcResult(req, method(req) === 'height' ? '100' : 'from-a');
    });
    const { transport, clock } = setup([A], fake, { healthIntervalMs: 60_000 });
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
      height: async (call) => BigInt(await call.rpc<string>('height')),
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const request = transport.rpc('x', [], { signal: controller.signal });
    await settle();
    const refresh = transport.refreshHealth();
    await settle();
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    await drive(clock, refresh);
    await expect(
      drive(clock, transport.rpc('y', [], { purpose: 'monitor' })),
    ).resolves.toBe('from-a');
    expect(identityCalls).toBe(2);
  });

  // I8: once a height probe is configured, proof reads exclude both a lagging endpoint and
  // one whose height is unknown (its probe failed), the same way.
  it('excludes both a lagging endpoint and an unknown-height endpoint from proof reads', async () => {
    const C: EndpointConfig = { name: 'c', url: 'https://c.test/rpc' };
    const fake = new FakeFetch()
      .route('https://a.test', (req) =>
        rpcResult(req, method(req) === 'height' ? '100' : 'from-a'),
      )
      .route('https://b.test', (req) =>
        rpcResult(req, method(req) === 'height' ? '90' : 'from-b'),
      )
      .route('https://c.test', (req) =>
        method(req) === 'height' ? { status: 503, text: '' } : rpcResult(req, 'from-c'),
      );
    const { transport, clock } = setup([A, B, C], fake, { maxLagBlocks: 5 });
    transport.setProbes({
      height: async (call) => BigInt(await call.rpc<string>('height')),
    });
    await drive(clock, transport.refreshHealth());
    await expect(drive(clock, transport.rpc('x', [], { quorum: 'proof' }))).resolves.toBe(
      'from-a',
    );
    // Neither b (lagging) nor c (unknown height) were asked for the proof read itself, only
    // for the height probe during refreshHealth().
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
    expect(fake.callsTo('https://c.test')).toHaveLength(1);
  });
});

// Fix round 4 (controller ruling R19): only identity-verified endpoints feed health heights.
describe('HttpTransport verified-only health heights', () => {
  // A is on chain 1 at height 100 (its first `aHeightFailures` height probes return 503).
  // B serves another network at height 1,000,000, and its first chain_id is a 503, so it is
  // identity-throttled (not yet known to be mismatched) for healthIntervalMs.
  const wrongNetworkB = (aHeightFailures = 0) => {
    let aHeightCalls = 0;
    let bIdentityCalls = 0;
    let bHeightCalls = 0;
    const fake = new FakeFetch()
      .route('https://a.test', (req) => {
        if (method(req) === 'chain_id') return rpcResult(req, '1');
        if (method(req) !== 'height') return rpcResult(req, 'from-a');
        aHeightCalls++;
        return aHeightCalls <= aHeightFailures
          ? { status: 503, text: '' }
          : rpcResult(req, '100');
      })
      .route('https://b.test', (req) => {
        if (method(req) === 'chain_id') {
          bIdentityCalls++;
          return bIdentityCalls === 1 ? { status: 503, text: '' } : rpcResult(req, '5');
        }
        if (method(req) !== 'height') return rpcResult(req, 'from-b');
        bHeightCalls++;
        return rpcResult(req, '1000000');
      });
    return { fake, bHeightCalls: () => bHeightCalls };
  };
  const probes = {
    identity: (call: EndpointCall) => call.rpc<string>('chain_id'),
    expectedIdentity: '1',
    height: async (call: EndpointCall) => BigInt(await call.rpc<string>('height')),
  };

  it('never takes a height from an identity-throttled endpoint on a direct refresh', async () => {
    const { fake, bHeightCalls } = wrongNetworkB();
    const { transport, clock } = setup([A, B], fake, { maxLagBlocks: 5 });
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    await drive(clock, transport.refreshHealth());
    expect(transport.highestHeight()).toBe(100n);
    expect(transport.status().find((s) => s.id === 'a')?.state).not.toBe('lagging');
    expect(bHeightCalls()).toBe(0);
  });

  // Deviation from the spec's "same setup": A's first height probe also fails, so the first
  // refresh fails entirely and the next one is driven by the outage backoff (1 s later) while
  // B is still identity-throttled. With A healthy from the start, ensureFreshHealth would not
  // refresh again until healthIntervalMs, when B's throttle has already expired.
  it('never takes a height from an identity-throttled endpoint on the outage-backoff path', async () => {
    const { fake, bHeightCalls } = wrongNetworkB(1);
    const { transport, clock } = setup([A, B], fake, {
      maxLagBlocks: 5,
      healthIntervalMs: 15_000,
    });
    transport.setProbes(probes);
    const heights: (bigint | undefined)[] = [];
    await drive(clock, transport.ensureFreshHealth());
    heights.push(transport.highestHeight());
    for (let elapsed = 0; elapsed < 16_000; elapsed += 1_000) {
      await clock.advance(1_000);
      await drive(clock, transport.ensureFreshHealth());
      heights.push(transport.highestHeight());
    }
    expect(heights.filter((h) => h !== undefined && h > 100n)).toEqual([]);
    expect(transport.status().find((s) => s.id === 'b')?.state).toBe('disabled');
    expect(transport.highestHeight()).toBe(100n);
    expect(bHeightCalls()).toBe(0);
  });

  // R19: a height recorded before an identity probe was configured stops counting once its
  // endpoint turns out to serve another network — #highest is rebuilt from verified ones.
  it('rebuilds highestHeight from verified endpoints when an endpoint is disabled', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) =>
        rpcResult(req, method(req) === 'chain_id' ? '1' : '100'),
      )
      .route('https://b.test', (req) =>
        rpcResult(req, method(req) === 'chain_id' ? '5' : '1000000'),
      );
    const { transport, clock } = setup([A, B], fake, { maxLagBlocks: 5 });
    transport.setProbes({ height: probes.height });
    await drive(clock, transport.refreshHealth());
    expect(transport.highestHeight()).toBe(1_000_000n);
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    expect(transport.status().find((s) => s.id === 'b')?.state).toBe('disabled');
    expect(transport.highestHeight()).toBe(100n);
    expect(transport.status().find((s) => s.id === 'a')?.state).toBe('healthy');
  });
});
