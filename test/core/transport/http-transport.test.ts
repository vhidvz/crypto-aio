import { inspect } from 'node:util';
import { createLogger } from '../../../src/core/events/logger';
import { secret } from '../../../src/core/secret/secret';
import {
  PLACEHOLDER_ORIGIN,
  type EndpointConfig,
} from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, hang, rpcError, rpcResult } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const method = (req: { json<T>(): T }) => req.json<{ method: string }>().method;

describe('HttpTransport requests', () => {
  it('sends JSON-RPC 2.0 requests with endpoint headers', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) =>
      rpcResult(req, `${method(req)}:ok`),
    );
    const { transport } = setup([{ ...A, headers: { 'x-api-key': secret('k') } }], fake);
    await expect(transport.rpc('chain_ping', ['p'])).resolves.toBe('chain_ping:ok');
    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
    });
    expect(JSON.parse(fake.calls[0]?.body ?? '')).toMatchObject({
      jsonrpc: '2.0',
      method: 'chain_ping',
      params: ['p'],
    });
  });

  it('fails over on 5xx and reports the failure', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 503, text: 'busy' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock, seen } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
    expect(seen.filter((e) => e.type === 'rpc.error')).toEqual([
      expect.objectContaining({
        endpointId: 'a',
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      }),
    ]);
  });

  it('does not retry definitive JSON-RPC errors', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => rpcError(req, -32000, 'nonce too low'))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('send'))).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
      details: { rpcCode: -32000, rpcMessage: 'nonce too low' },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('treats -32005 as rate limiting and fails over', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => rpcError(req, -32005, 'limit exceeded'))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  it('honours Retry-After', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (req) =>
      calls++ === 0
        ? { status: 429, text: 'slow down', headers: { 'retry-after': '2' } }
        : rpcResult(req, 'ok'),
    );
    const { transport, clock } = setup([A], fake);
    const start = clock.now();
    await expect(drive(clock, transport.rpc('x'), 100)).resolves.toBe('ok');
    expect(clock.now() - start).toBeGreaterThanOrEqual(2_000);
  });

  // An HTML maintenance page must not crash the client.
  it('fails over when a provider answers 200 with an HTML page', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({
        text: '<html><body>Scheduled maintenance</body></html>',
      }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  it('reports PROVIDER_UNAVAILABLE, not a SyntaxError, when every endpoint returns HTML', async () => {
    const fake = new FakeFetch().route('https://a.test', () => ({
      text: '<html>down</html>',
    }));
    const { transport, clock } = setup([A], fake);
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringMatching(/non-JSON body/),
    });
  });

  // Secrets in provider URLs never leak through error causes or events.
  it('never leaks endpoint secrets through errors or events', async () => {
    const fake = new FakeFetch().route('https://node.test', () => {
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED https://node.test/v1/sk_live_SUPERSECRET'),
      });
    });
    const { transport, clock, seen } = setup(
      [
        {
          name: 'main',
          url: secret('https://node.test/v1/sk_live_SUPERSECRET'),
          headers: { authorization: secret('Bearer TOPSECRETTOKEN') },
        },
      ],
      fake,
    );
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((error as Error).message).toContain('<main>');
    for (const text of [
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(seen),
    ]) {
      expect(text).not.toContain('SUPERSECRET');
      expect(text).not.toContain('TOPSECRETTOKEN');
    }
  });

  // A secret in the endpoint URL's query string never leaks.
  it('never leaks a secret embedded in the endpoint URL query string', async () => {
    const fake = new FakeFetch().route('https://node.test', () => {
      throw new TypeError('fetch failed', {
        cause: new Error(
          'connect ECONNREFUSED https://node.test/v1?api_key=sk_live_QUERYSECRET',
        ),
      });
    });
    const { transport, clock, seen } = setup(
      [{ name: 'main', url: secret('https://node.test/v1?api_key=sk_live_QUERYSECRET') }],
      fake,
    );
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    for (const text of [
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(seen),
      JSON.stringify(transport.status()),
    ]) {
      expect(text).not.toContain('sk_live_QUERYSECRET');
    }
  });

  // A secret in the endpoint URL's userinfo never leaks.
  it('never leaks a secret embedded in the endpoint URL userinfo', async () => {
    const fake = new FakeFetch().route('https://node.test', () => {
      throw new TypeError('fetch failed', {
        cause: new Error(
          'connect ECONNREFUSED https://user:sk_live_USERINFOSECRET@node.test/v1',
        ),
      });
    });
    const { transport, clock, seen } = setup(
      [{ name: 'main', url: secret('https://user:sk_live_USERINFOSECRET@node.test/v1') }],
      fake,
    );
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    for (const text of [
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(seen),
      JSON.stringify(transport.status()),
    ]) {
      expect(text).not.toContain('sk_live_USERINFOSECRET');
    }
  });

  // A capture logger (not noopLogger) never records the secret either. The identity
  // probe's mismatch warning is the transport's only log call site, so a mismatch scenario is
  // used to prove the assertion isn't vacuous.
  it('never logs a secret through a capture logger', async () => {
    const records: unknown[] = [];
    const log = createLogger('test', (level, namespace, message, fields) => {
      records.push({ level, namespace, message, fields });
    });
    const fake = new FakeFetch().route('https://node.test', (req) =>
      rpcResult(req, method(req) === 'chain_id' ? '5' : 'ok'),
    );
    const { transport, clock } = setup(
      [{ name: 'main', url: 'https://node.test/v1/sk_live_LOGSECRET' }],
      fake,
      {},
      log,
    );
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('x'))).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
    });
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain('sk_live_LOGSECRET');
    }
  });

  it('times out slow endpoints and marks failed broadcasts ambiguous', async () => {
    const fake = new FakeFetch().route('https://a.test', (_req, signal) => hang(signal));
    const { transport, clock } = setup([A], fake, { maxAttempts: 2 });
    const error = await drive(
      clock,
      transport.rpc('send', [], { retry: 'ambiguous-on-failure', timeoutMs: 1_000 }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'TIMEOUT', ambiguous: true, retryable: true });
    expect(fake.calls).toHaveLength(2);
  });

  it('makes exactly one attempt for never-auto requests', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 503, text: '' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(
      drive(clock, transport.rpc('x', [], { retry: 'never-auto' })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      ambiguous: false,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('opens the circuit after repeated failures and probes after openMs', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 503, text: '' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup(
      [
        { ...A, priority: 0 },
        { ...B, priority: 1 },
      ],
      fake,
      {
        failureThreshold: 2,
        openMs: 1_000,
      },
    );
    for (let i = 0; i < 3; i++) await drive(clock, transport.rpc('x'));
    expect(fake.callsTo('https://a.test')).toHaveLength(2);
    expect(transport.status().find((s) => s.id === 'a')?.state).toBe('open');
    await clock.advance(1_000);
    await drive(clock, transport.rpc('x'));
    expect(fake.callsTo('https://a.test')).toHaveLength(3);
  });

  it('rate limits per endpoint', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcResult(req, 'ok'));
    const { transport, clock } = setup([{ ...A, rateLimit: { rps: 1, burst: 1 } }], fake);
    const start = clock.now();
    await drive(clock, Promise.all([transport.rpc('x'), transport.rpc('y')]), 50);
    expect(clock.now() - start).toBeGreaterThanOrEqual(1_000);
  });

  it('bridges fetch for SDKs without exposing real URLs', async () => {
    const fake = new FakeFetch().route('https://sol.test/rpc', (req) => ({
      json: { seen: req.url.href, body: req.body, key: req.headers.get('x-key') },
    }));
    const { transport, clock } = setup(
      [
        {
          name: 's',
          url: 'https://sol.test/rpc?q=2',
          headers: { 'x-key': secret('kk') },
        },
      ],
      fake,
    );
    const bridged = transport.createFetch();
    const response = await drive(
      clock,
      bridged(`${PLACEHOLDER_ORIGIN}/?a=1`, {
        method: 'POST',
        body: '{"x":1}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(response.json()).resolves.toEqual({
      seen: 'https://sol.test/rpc?q=2&a=1',
      body: '{"x":1}',
      key: 'kk',
    });
    await expect(bridged('https://evil.test/x')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('joins REST paths, supports text responses and does not retry 4xx', async () => {
    const fake = new FakeFetch()
      .route('https://esplora.test/api/blocks/tip/height', () => ({ text: '812345' }))
      .route('https://esplora.test/api/tx/', () => ({
        status: 404,
        text: 'Transaction not found',
      }));
    const { transport, clock } = setup(
      [{ name: 'e', url: 'https://esplora.test/api', kind: 'indexer' }],
      fake,
    );
    await expect(
      drive(
        clock,
        transport.http({
          method: 'GET',
          path: '/blocks/tip/height',
          responseType: 'text',
        }),
      ),
    ).resolves.toBe('812345');
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/tx/abc' })),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      details: { status: 404, body: 'Transaction not found' },
    });
    expect(fake.callsTo('https://esplora.test/api/tx/')).toHaveLength(1);
  });
});
