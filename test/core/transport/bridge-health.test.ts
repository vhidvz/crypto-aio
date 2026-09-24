import { inspect } from 'node:util';
import {
  PLACEHOLDER_ORIGIN,
  type EndpointConfig,
} from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
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
  // I8: two concurrent monitor reads started during the first refresh must both be served by
  // the non-lagging endpoint, and must share a single underlying refresh.
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
        { ...A, priority: 0 },
        { ...B, priority: 1 },
      ],
      fake,
      { maxLagBlocks: 5 },
    );
    transport.setProbes({
      height: async (call) => BigInt(await call.rpc<string>('height')),
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
