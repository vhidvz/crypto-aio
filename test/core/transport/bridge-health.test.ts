import { inspect } from 'node:util';
import {
  PLACEHOLDER_ORIGIN,
  type EndpointConfig,
} from '../../../src/core/transport/types';
import { drive, settle } from '../../../src/testing/fake-clock';
import { FakeFetch, rpcResult, type FakeRequest } from '../../../src/testing/fake-fetch';
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
    await expect(
      drive(clock, transport.rpc('x', [], { purpose: 'monitor' })),
    ).resolves.toBe('from-a');
    expect(heightCalls).toBe(2);
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
