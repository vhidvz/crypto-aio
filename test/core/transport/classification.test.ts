import { inspect } from 'node:util';
import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
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

// Fix round 1, group A: response classification, scrubbing and event route labels
// (controller ruling R14, task-15-fix-1.md items I2, I3, I5, I6a, I6b, M10).
describe('HttpTransport response classification and scrubbing', () => {
  // I2: rpcData is scrubbed the same way rpcMessage is.
  it('scrubs error.data in JSON-RPC error responses', async () => {
    const fake = new FakeFetch().route('https://h.io', (req) => ({
      json: {
        jsonrpc: '2.0',
        id: req.json<{ id: unknown }>().id,
        error: {
          code: -32000,
          message: 'boom',
          data: 'seen at https://h.io/v1/sk_live_SECRETKEY123456',
        },
      },
    }));
    const { transport, clock } = setup(
      [{ name: 'h', url: 'https://h.io/v1/sk_live_SECRETKEY123456' }],
      fake,
    );
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR' });
    for (const text of [JSON.stringify(error), inspect(error, { depth: 10 })]) {
      expect(text).not.toContain('sk_live_SECRETKEY123456');
    }
  });

  // I3: event method labels never carry the raw REST path; `route` supplies a safe template.
  it('keeps the raw path out of events and uses the route template as the label', async () => {
    const fake = new FakeFetch().route('https://a.test', () => ({ text: 'ok' }));
    const { transport, clock, seen } = setup([A], fake);
    await drive(
      clock,
      transport.http({
        method: 'GET',
        path: '/address/bc1qSECRETADDRESS/utxo',
        responseType: 'text',
      }),
    );
    for (const event of seen) {
      expect(JSON.stringify(event)).not.toContain('bc1qSECRETADDRESS');
    }
    seen.length = 0;
    await drive(
      clock,
      transport.http({
        method: 'GET',
        path: '/address/bc1qSECRETADDRESS/utxo',
        route: '/address/:address/utxo',
        responseType: 'text',
      }),
    );
    expect(seen.filter((e) => e.type === 'rpc.request')).toEqual([
      expect.objectContaining({ method: 'GET /address/:address/utxo' }),
    ]);
  });

  // I5: envelope validation order — id mismatch fails over rather than being classified.
  it('fails over on an error envelope with the wrong id', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({
        json: { jsonrpc: '2.0', id: 999_999, error: { code: -32000, message: 'nope' } },
      }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
  });

  // I5: exactly one of result/error must be present.
  it('fails over when both result and error are present', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => ({
        json: {
          jsonrpc: '2.0',
          id: req.json<{ id: unknown }>().id,
          result: 'ignored',
          error: { code: -32000, message: 'nope' },
        },
      }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
  });

  // I6a: an identity-probe failure (not a confirmed mismatch) is retryable and fails over.
  it('fails over when the identity probe itself errors', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) =>
        method(req) === 'chain_id'
          ? {
              json: {
                jsonrpc: '2.0',
                id: req.json<{ id: unknown }>().id,
                error: { code: -32601, message: 'method not found' },
              },
            }
          : rpcResult(req, 'from-a'),
      )
      .route('https://b.test', (req) =>
        rpcResult(req, method(req) === 'chain_id' ? '1' : 'from-b'),
      );
    const { transport, clock } = setup([A, B], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('from-b');
  });

  // I6b: an rpc-mode 4xx without a valid envelope is retryable and fails over.
  it('fails over on an rpc-mode 404 with an HTML body', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 404, text: '<html>Not Found</html>' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  // M10: malformed-response classes each become PROVIDER_UNAVAILABLE and fail over.
  it('fails over on an empty JSON-RPC body', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ text: '' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  it('fails over on truncated JSON', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ text: '{"jsonrpc":"2.0","id":1,"resu' }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  it('fails over on a non-object JSON body', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ json: 42 }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake);
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('b');
  });

  // R17 refinement (round 2, item 6): a REST 4xx is a definitive, non-retryable answer from
  // the endpoint — it must not itself set mayHaveSent.
  it('a first-attempt REST 400 is not ambiguous', async () => {
    const fake = new FakeFetch().route('https://a.test', () => ({
      status: 400,
      text: 'bad-txns-inputs-missingorspent',
    }));
    const { transport, clock } = setup([A], fake, { maxAttempts: 1 });
    const error = await drive(
      clock,
      transport.http({ method: 'POST', path: '/tx' }, { retry: 'ambiguous-on-failure' }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: false });
  });

  // R17: the same 400 still inherits ambiguity from an earlier possibly-delivered attempt.
  it('the same REST 400 after an earlier timeout is ambiguous', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (_req, signal) =>
      calls++ === 0
        ? hang(signal)
        : { status: 400, text: 'bad-txns-inputs-missingorspent' },
    );
    const { transport, clock } = setup([A], fake, { maxAttempts: 2 });
    const error = await drive(
      clock,
      transport.http(
        { method: 'POST', path: '/tx' },
        { retry: 'ambiguous-on-failure', timeoutMs: 1_000 },
      ),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: true });
  });

  it('fails over on an HTML body from http() in JSON mode', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ text: '<html>down</html>' }))
      .route('https://b.test', () => ({ json: { ok: true } }));
    const { transport, clock } = setup([A, B], fake);
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/x' })),
    ).resolves.toEqual({ ok: true });
  });
});
