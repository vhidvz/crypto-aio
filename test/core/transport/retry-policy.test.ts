import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive, settle } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  hang,
  rpcError,
  rpcResult,
  type FakeRequest,
} from '../../../src/testing/fake-fetch';
import { thrown } from '../../helpers';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const method = (req: FakeRequest) => req.json<{ method: string }>().method;

// Fix round 1, group B: retry loop, breaker, per-endpoint limits, validation
// (controller ruling R14, task-15-fix-1.md items I4, I7, I9, I10, M3, M4, M12, M10).
describe('HttpTransport retry policy', () => {
  // I7: an abandoned half-open probe must not lock the endpoint out.
  it('leaves a half-open endpoint usable after the caller aborts the probe', async () => {
    let mode: 'fail' | 'hang' | 'ok' = 'fail';
    const fake = new FakeFetch().route('https://a.test', (req, signal) => {
      if (mode === 'fail') return { status: 503, text: '' };
      if (mode === 'hang') return hang(signal);
      return rpcResult(req, 'ok');
    });
    const { transport, clock } = setup([A], fake, { failureThreshold: 1, openMs: 1_000 });

    await expect(
      drive(clock, transport.rpc('x'), 50).catch((e: unknown) => Promise.reject(e)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(transport.status()[0]?.state).toBe('open');

    await clock.advance(1_000);
    expect(transport.status()[0]?.state).toBe('half-open');

    mode = 'hang';
    const controller = new AbortController();
    const probe = transport.rpc('y', [], { signal: controller.signal });
    await settle();
    controller.abort(new Error('cancelled'));
    await expect(probe).rejects.toThrow('cancelled');
    expect(transport.status()[0]?.state).toBe('half-open');

    mode = 'ok';
    await expect(drive(clock, transport.rpc('z'))).resolves.toBe('ok');
  });

  // I9: Retry-After on one endpoint must not stall failover to a healthy one, and the
  // per-endpoint limit must persist across calls.
  it('fails over immediately on Retry-After and persists the limit across calls', async () => {
    let aCalls = 0;
    let bUp = true;
    const fake = new FakeFetch()
      .route('https://a.test', () => {
        aCalls++;
        return { status: 429, text: '', headers: { 'retry-after': '60' } };
      })
      .route('https://b.test', (req) =>
        bUp ? rpcResult(req, 'b') : { status: 503, text: '' },
      );
    const { transport, clock } = setup([A, B], fake);
    const start = clock.now();

    await expect(transport.rpc('x')).resolves.toBe('b');
    expect(clock.now() - start).toBe(0);
    expect(aCalls).toBe(1);

    await expect(transport.rpc('y')).resolves.toBe('b');
    expect(aCalls).toBe(1);

    // A stays excluded until its 60s Retry-After elapses; take B out of the running so a
    // second attempt against A (proving it's eligible again) is observable.
    await clock.advance(60_000);
    bUp = false;
    await drive(clock, transport.rpc('z')).catch(() => undefined);
    expect(aCalls).toBe(2);
  });

  // I10: PROVIDER_MISCONFIGURED is only retryable internally; once every endpoint is
  // exhausted the caller must see it as final.
  it('surfaces a final PROVIDER_MISCONFIGURED as non-retryable', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 401, text: '' }))
      .route('https://b.test', () => ({ status: 401, text: '' }));
    const { transport, clock } = setup([A, B], fake);
    const error = await drive(clock, transport.rpc('x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_MISCONFIGURED', retryable: false });
  });

  // I4: a later definitive error inherits ambiguity from an earlier possibly-delivered attempt.
  it('marks a later definitive error ambiguous when an earlier attempt may have been delivered', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (req, signal) =>
      calls++ === 0 ? hang(signal) : rpcError(req, -32000, 'nonce too low'),
    );
    const { transport, clock } = setup([A], fake, { maxAttempts: 2 });
    const error = await drive(
      clock,
      transport.rpc('send', [], { retry: 'ambiguous-on-failure', timeoutMs: 1_000 }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: true });
  });

  // I4: the same holds for a fanout, where the ambiguous attempt is a sibling, not a retry.
  it('marks a fanout failure ambiguous when a sibling attempt may have been delivered', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (_req, signal) => hang(signal))
      .route('https://b.test', (req) => rpcError(req, -32000, 'nonce too low'));
    const { transport, clock } = setup([A, B], fake);
    const error = await drive(
      clock,
      transport.rpc('send', [], {
        fanout: 2,
        retry: 'ambiguous-on-failure',
        timeoutMs: 1_000,
      }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: true });
  });

  // I4: a lone definitive rejection, with no possibly-delivered attempt before it, is not ambiguous.
  it('does not mark a lone definitive rejection ambiguous', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) =>
      rpcError(req, -32000, 'nonce too low'),
    );
    const { transport, clock } = setup([A], fake);
    const error = await drive(
      clock,
      transport.rpc('send', [], { retry: 'ambiguous-on-failure' }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: false });
  });

  // M3: a local serialization error never reaches an endpoint.
  it('rejects unserializable params before touching any endpoint', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcResult(req, 'ok'));
    const { transport } = setup([A], fake);
    await expect(transport.rpc('x', [1n])).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      retryable: false,
    });
    expect(fake.calls).toHaveLength(0);
  });

  // M4: options and endpoint URLs are validated at construction, without leaking the URL.
  it('validates transport options and endpoint URLs at construction', () => {
    const fake = new FakeFetch();
    expect(thrown(() => setup([A], fake, { maxAttempts: 0 }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(thrown(() => setup([A], fake, { timeoutMs: -1 }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    const error = thrown(() => setup([{ name: 'bad', url: 'ftp://a.test/rpc' }], fake));
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain('ftp://a.test');
  });

  // M12: a fresh probe set must be re-checked, not trusted from a prior confirmation.
  it('setProbes resets identity to unchecked', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) =>
      method(req) === 'chain_id' ? rpcResult(req, '1') : rpcResult(req, 'ok'),
    );
    const { transport, clock } = setup([A], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('x'))).resolves.toBe('ok');

    let probed = 0;
    transport.setProbes({
      identity: (call) => {
        probed++;
        return call.rpc<string>('chain_id');
      },
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('y'))).resolves.toBe('ok');
    expect(probed).toBe(1);
  });

  // M12: a definitive answer proves the endpoint healthy and resets its failure count.
  it('a definitive answer resets endpoint.failures', async () => {
    let mode: 'fail' | 'definitive' = 'fail';
    const fake = new FakeFetch().route('https://a.test', (req) =>
      mode === 'fail'
        ? { status: 503, text: '' }
        : rpcError(req, -32000, 'nonce too low'),
    );
    const { transport, clock } = setup([A], fake, { maxAttempts: 1 });
    await expect(drive(clock, transport.rpc('x'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(transport.status()[0]?.failures).toBe(1);

    mode = 'definitive';
    await expect(drive(clock, transport.rpc('y'))).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
    expect(transport.status()[0]?.failures).toBe(0);
  });

  // M10: a caller abort makes exactly one call and surfaces the abort reason.
  it('a caller abort makes exactly one call and surfaces the abort reason', async () => {
    const fake = new FakeFetch().route('https://a.test', (_req, signal) => hang(signal));
    const { transport } = setup([A], fake);
    const controller = new AbortController();
    const reason = new Error('nevermind');
    const promise = transport.rpc('x', [], { signal: controller.signal });
    await settle();
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(fake.calls).toHaveLength(1);
  });

  // M10: Retry-After is clamped at 60s.
  it('clamps Retry-After at 60s', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (req) =>
      calls++ === 0
        ? { status: 429, text: '', headers: { 'retry-after': '120' } }
        : rpcResult(req, 'ok'),
    );
    const { transport, clock } = setup([A], fake);
    const start = clock.now();
    await expect(drive(clock, transport.rpc('x'), 1_000)).resolves.toBe('ok');
    expect(clock.now() - start).toBeGreaterThanOrEqual(60_000);
    expect(clock.now() - start).toBeLessThan(120_000);
  });
});
