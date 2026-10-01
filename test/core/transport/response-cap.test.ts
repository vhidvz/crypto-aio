import { PLACEHOLDER_ORIGIN } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const CHUNK = 64 * 1024;
const id = (req: FakeRequest) => req.json<{ id: unknown }>().id;

/** An answer that never ends, counting the bytes the transport pulled from it. */
function endless(): { readonly response: Response; pulled(): number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
    },
  });
  return { response: new Response(stream, { status: 200 }), pulled: () => pulled };
}

describe('HttpTransport: an answer is at most maxResponseBytes (Plan 7 D10, lesson 20)', () => {
  const LIMIT = 1024 * 1024;

  it('cancels an endless answer at the cap and fails over to an honest endpoint', async () => {
    const liar = endless();
    const fake = new FakeFetch()
      .route('https://liar.example', () => liar.response)
      .route('https://honest.example', (req) => ({
        json: { jsonrpc: '2.0', id: id(req), result: '0x1' },
      }));
    const { transport, clock } = setup(
      [
        { name: 'liar', url: 'https://liar.example', priority: 0 },
        { name: 'honest', url: 'https://honest.example', priority: 1 },
      ],
      fake,
      { maxResponseBytes: LIMIT },
    );
    await expect(drive(clock, transport.rpc('eth_blockNumber'))).resolves.toBe('0x1');
    expect(liar.pulled()).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
  });

  it('fails a lone oversized answer as a retryable PROVIDER_UNAVAILABLE', async () => {
    const fake = new FakeFetch().route('https://liar.example', () => endless().response);
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
      },
    );
    await expect(drive(clock, transport.rpc('eth_blockNumber'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: `endpoint answered more than ${LIMIT} bytes`,
    });
  });

  it('refuses a declared length above the cap before reading the body', async () => {
    const liar = endless();
    const fake = new FakeFetch().route(
      'https://liar.example',
      () =>
        new Response(liar.response.body, {
          headers: { 'content-length': String(LIMIT + 1) },
        }),
    );
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      { maxResponseBytes: LIMIT, maxAttempts: 1 },
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/blocks', route: '/blocks' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(liar.pulled()).toBeLessThanOrEqual(CHUNK);
  });

  it('reads an answer of exactly the cap whole', async () => {
    const text = 'x'.repeat(LIMIT - 2);
    const fake = new FakeFetch().route('https://node.example', () => ({
      text: JSON.stringify(text),
    }));
    const { transport, clock } = setup(
      [{ name: 'node', url: 'https://node.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
      },
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/big', route: '/big' })),
    ).resolves.toHaveLength(LIMIT - 2);
  });

  it('caps what the SDK bridge hands a native client too', async () => {
    const fake = new FakeFetch().route('https://liar.example', () => endless().response);
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
        maxAttempts: 1,
      },
    );
    const bridged = transport.createFetch();
    await expect(
      drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/x`, { method: 'POST', body: '{}' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(() =>
        setup([{ name: 'n', url: 'https://n.example' }], new FakeFetch(), {
          maxResponseBytes,
        }),
      ).toThrow('maxResponseBytes must be an integer > 0');
    }
  });
});
