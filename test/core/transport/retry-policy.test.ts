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

  // N2 (round 2, item 4): an identity-throttled endpoint is excluded from #candidates, the
  // same way notBefore excludes a rate-limited one — a never-auto call must not waste its
  // single attempt on an endpoint already known to be identity-unreachable.
  it('excludes an identity-throttled endpoint from a following never-auto call', async () => {
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
    const { transport, clock } = setup(
      [
        { ...A, priority: 0 },
        { ...B, priority: 1 },
      ],
      fake,
    );
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    await expect(drive(clock, transport.rpc('warm'))).resolves.toBe('from-b');
    const aCallsAfterFirst = fake.callsTo('https://a.test').length;
    await expect(
      drive(clock, transport.rpc('x', [], { retry: 'never-auto' })),
    ).resolves.toBe('from-b');
    expect(fake.callsTo('https://a.test')).toHaveLength(aCallsAfterFirst);
  });

  // N2: a caller abort during the identity probe must not set the throttle — a
  // single-endpoint transport must still be able to serve the next call.
  it('lets a single-endpoint transport serve the next call after a caller abort during the identity probe', async () => {
    let identityCalls = 0;
    const fake = new FakeFetch().route('https://a.test', (req, signal) => {
      if (method(req) !== 'chain_id') return rpcResult(req, 'from-a');
      identityCalls++;
      // Only the first (aborted) probe hangs; a later probe succeeds, proving the endpoint
      // can still be re-checked rather than being locked out by a throttle it never earned.
      return identityCalls === 1 ? hang(signal) : rpcResult(req, '1');
    });
    const { transport, clock } = setup([A], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const probe = transport.rpc('x', [], { signal: controller.signal });
    await settle();
    controller.abort(reason);
    await expect(probe).rejects.toBe(reason);
    await expect(drive(clock, transport.rpc('y'))).resolves.toBe('from-a');
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

  // N3 (round 2, item 5): needed is sized from the full candidate set, not the
  // rate-limit-filtered eligible set — a required endpoint being rate-limited must not
  // silently shrink the quorum to whatever's left.
  it('never resolves a proof quorum from fewer endpoints than required', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', () => ({
        status: 429,
        text: '',
        headers: { 'retry-after': '60' },
      }))
      .route('https://b.test', (req) => rpcResult(req, 'b'));
    const { transport, clock } = setup([A, B], fake, { proofQuorum: 2 });
    // Prime A's rate limit via an ordinary call first, so it's already excluded from the
    // eligible set by the time the quorum call sizes `needed`.
    await expect(drive(clock, transport.rpc('warm'))).resolves.toBe('b');
    await expect(
      drive(clock, transport.rpc('x', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ retryable: true });
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
    // #11 (round 2): #pick's wait is now bounded by the call's timeoutMs, so this call must
    // allow enough budget for the clamped (not the raw, unclamped) Retry-After to elapse.
    await expect(
      drive(clock, transport.rpc('x', [], { timeoutMs: 65_000 }), 1_000),
    ).resolves.toBe('ok');
    expect(clock.now() - start).toBeGreaterThanOrEqual(60_000);
    expect(clock.now() - start).toBeLessThan(120_000);
  });

  // #11 (round 2): #pick's wait for a rate-limited endpoint is bounded by the call's
  // timeoutMs — a persisted rate limit from an earlier call must not stall a fresh call with
  // a short timeout, and the throttled endpoint must not even be re-attempted.
  it('fails at once on a persisted rate limit whose wait exceeds a fresh call timeout', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', () => {
      calls++;
      return { status: 429, text: '', headers: { 'retry-after': '60' } };
    });
    const { transport, clock } = setup([A], fake, { maxAttempts: 1 });
    // First call sets notBefore 60s out.
    await drive(clock, transport.rpc('warm')).catch(() => undefined);
    expect(calls).toBe(1);
    const start = clock.now();
    const error = await drive(
      clock,
      transport.rpc('x', [], { timeoutMs: 500 }),
      50,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      ambiguous: false,
    });
    expect(clock.now() - start).toBeLessThan(1_000);
    expect(calls).toBe(1); // the endpoint was never attempted again
  });

  // R16 (controller amendment): mayHaveSent widens beyond timeout/network-error/5xx/unparseable
  // to every post-fetch endpoint failure except HTTP 401/403/429 — including a JSON-RPC
  // envelope-validation failure (here, an id mismatch).
  it('marks ambiguous when an envelope id-mismatch precedes a definitive JSON-RPC error', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (req) =>
      calls++ === 0
        ? {
            json: {
              jsonrpc: '2.0',
              id: 999_999,
              error: { code: -32000, message: 'nope' },
            },
          }
        : rpcError(req, -32000, 'nonce too low'),
    );
    const { transport, clock } = setup([A], fake, { maxAttempts: 2 });
    const error = await drive(
      clock,
      transport.rpc('send', [], { retry: 'ambiguous-on-failure' }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: true });
    expect(calls).toBe(2);
  });

  // M3/#2 (round 2): a token-bucket wait that exceeds the call's timeoutMs fails with
  // RATE_LIMITED, retryable, untagged — no fetch was ever attempted, so the breaker (and its
  // failure counter) must stay untouched.
  it('a token-wait timeout leaves the breaker closed and gives ambiguous: false', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcResult(req, 'ok'));
    const { transport, clock } = setup(
      [{ ...A, rateLimit: { rps: 1, burst: 1 } }],
      fake,
      { maxAttempts: 1 },
    );
    // Consume the single burst token first.
    await drive(clock, transport.rpc('warm'));
    const error = await drive(
      clock,
      transport.rpc('x', [], { retry: 'ambiguous-on-failure', timeoutMs: 500 }),
      50,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      ambiguous: false,
    });
    expect(transport.status()[0]?.failures).toBe(0);
  });

  // R16: HTTP 429 stays excluded from ambiguity — the server never processed the request.
  it('does not mark ambiguous when only a 429 precedes a definitive error', async () => {
    let calls = 0;
    const fake = new FakeFetch().route('https://a.test', (req) =>
      calls++ === 0
        ? { status: 429, text: '', headers: { 'retry-after': '1' } }
        : rpcError(req, -32000, 'nonce too low'),
    );
    const { transport, clock } = setup([A], fake, { maxAttempts: 2 });
    const error = await drive(
      clock,
      transport.rpc('send', [], { retry: 'ambiguous-on-failure' }),
      100,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', ambiguous: false });
    expect(calls).toBe(2);
  });
});
