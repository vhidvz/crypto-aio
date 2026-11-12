import type { CryptoAioError } from '../../../src/core/errors/error';
import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const endpoint = (name: string): EndpointConfig => ({
  name,
  url: `https://${name}.test/api`,
  kind: 'indexer',
});
const TOO_LARGE = 'Scripthash history too large to scan';
const limit = (refusal: CryptoAioError) => refusal.details?.body === TOO_LARGE;
const get = { method: 'GET', path: '/address/x', route: '/address/:address' } as const;

/** Each named endpoint answers its own status and body. */
function indexers(answers: Record<string, { status: number; text: string }>) {
  const fake = new FakeFetch();
  for (const [name, answer] of Object.entries(answers))
    fake.route(`https://${name}.test`, () => answer);
  return fake;
}

// CallOptions.endpointLimit: a refusal for one endpoint's own limit fails over.
describe('HttpTransport endpoint limits', () => {
  it("asks the next endpoint when one refuses for its own limit, and returns that endpoint's answer", async () => {
    const fake = indexers({
      a: { status: 400, text: TOO_LARGE },
      b: { status: 200, text: '{"ok":true}' },
    });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).resolves.toEqual({ ok: true });
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
  });

  it('keeps a refusal definitive without the option, or when the option says it is not a limit', async () => {
    for (const options of [{}, { endpointLimit: () => false }]) {
      const fake = indexers({
        a: { status: 400, text: TOO_LARGE },
        b: { status: 200, text: '{"ok":true}' },
      });
      const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
      await expect(drive(clock, transport.http(get, options))).rejects.toMatchObject({
        code: 'RPC_ERROR',
        retryable: false,
        details: { status: 400, body: TOO_LARGE },
      });
      expect(fake.callsTo('https://b.test')).toHaveLength(0);
    }
  });

  it('lets the refusal stand once every endpoint has refused, asking each once', async () => {
    const fake = indexers({
      a: { status: 400, text: TOO_LARGE },
      b: { status: 400, text: TOO_LARGE },
    });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
      details: { status: 400, body: TOO_LARGE },
    });
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(1);
  });

  it('uses up no retry on a limit, so endpoints past maxAttempts are still asked', async () => {
    const fake = indexers({
      a: { status: 400, text: TOO_LARGE },
      b: { status: 400, text: TOO_LARGE },
      c: { status: 400, text: TOO_LARGE },
      d: { status: 200, text: '{"ok":true}' },
    });
    const { transport, clock } = setup(['a', 'b', 'c', 'd'].map(endpoint), fake, {
      maxAttempts: 2,
    });
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(4);
  });

  it('still retries a retryable failure on the endpoint after a limit', async () => {
    let calls = 0;
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 400, text: TOO_LARGE }))
      .route('https://b.test', () =>
        ++calls === 1 ? { status: 503, text: '' } : { status: 200, text: '{"ok":true}' },
      );
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake);
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).resolves.toEqual({ ok: true });
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('never asks an endpoint again once it refused for its limit, even on a retry', async () => {
    // b fails first (a retry), then a refuses for its limit; the retry goes to b again.
    let calls = 0;
    const fake = new FakeFetch()
      .route('https://a.test', () => ({ status: 400, text: TOO_LARGE }))
      .route('https://b.test', () =>
        ++calls < 3 ? { status: 503, text: '' } : { status: 200, text: '{"ok":true}' },
      );
    const { transport, clock } = setup([endpoint('b'), endpoint('a')], fake, {
      maxAttempts: 3,
    });
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).resolves.toEqual({ ok: true });
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("ends with the other endpoint's retryable failure when only it is left and it keeps failing", async () => {
    const fake = indexers({
      a: { status: 400, text: TOO_LARGE },
      b: { status: 503, text: '' },
    });
    const { transport, clock } = setup([endpoint('a'), endpoint('b')], fake, {
      maxAttempts: 2,
    });
    await expect(
      drive(clock, transport.http(get, { endpointLimit: limit })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(fake.callsTo('https://a.test')).toHaveLength(1);
    expect(fake.callsTo('https://b.test')).toHaveLength(2);
  });
});
