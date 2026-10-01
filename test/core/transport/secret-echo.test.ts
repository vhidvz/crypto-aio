import { inspect } from 'node:util';
import { secret } from '../../../src/core/secret/secret';
import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';
const id = (req: FakeRequest) => req.json<{ id: unknown }>().id;

/** Every text a caller, a logger or an event consumer can see of an error. */
async function surfaces(run: () => Promise<unknown>, seen: readonly unknown[]) {
  const error = await run().catch((e: unknown) => e);
  return {
    error,
    text: [
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(seen),
    ].join('\n'),
  };
}

const expectNoKey = (text: string, key = KEY) =>
  expect(text.toLowerCase()).not.toContain(key.toLowerCase());

describe('HttpTransport: a secret echoed back by a provider never leaves (F3-R20)', () => {
  const pathKeyed: EndpointConfig = {
    name: 'keyed',
    url: secret(`https://node.example/v2/${KEY}`),
  };

  it('scrubs a bare key from a JSON-RPC error message and its data, in any case', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: {
        jsonrpc: '2.0',
        id: id(req),
        error: {
          code: -32000,
          message: `invalid api key ${KEY.toUpperCase()}`,
          data: { key: KEY, hint: `use ${encodeURIComponent(KEY)}` },
        },
      },
    }));
    const { transport, clock, seen } = setup([pathKeyed], fake);
    const { error, text } = await surfaces(
      () => drive(clock, transport.rpc('eth_call')),
      seen,
    );
    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      details: { rpcMessage: 'invalid api key [REDACTED]' },
    });
    expectNoKey(text);
  });

  it('scrubs a bare key from a REST error body, and names the route, not the path', async () => {
    const fake = new FakeFetch().route('https://indexer.example', () => ({
      status: 400,
      text: `{"error":"key ${KEY} is not allowed"}`,
    }));
    const { transport, clock, seen } = setup(
      [
        {
          name: 'idx',
          url: 'https://indexer.example/api',
          headers: { 'x-api-key': secret(KEY) },
        },
      ],
      fake,
    );
    const { error, text } = await surfaces(
      () =>
        drive(
          clock,
          transport.http({
            method: 'GET',
            path: '/address/bc1qCUSTOMERADDRESS/txs',
            route: '/address/:address/txs',
          }),
        ),
      seen,
    );
    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      message: 'GET /address/:address/txs refused (HTTP 400)',
      details: { status: 400, body: '{"error":"key [REDACTED] is not allowed"}' },
    });
    expectNoKey(text);
    expect(text).not.toContain('bc1qCUSTOMERADDRESS');
  });

  it('names only the method when a REST call gives no route', async () => {
    const fake = new FakeFetch().route('https://indexer.example', () => ({
      status: 404,
      text: 'not found',
    }));
    const { transport, clock } = setup(
      [{ name: 'idx', url: 'https://indexer.example' }],
      fake,
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/tx/abc123' })),
    ).rejects.toMatchObject({ message: 'GET refused (HTTP 404)' });
  });

  it('scrubs the token after an auth scheme and a Basic password from a fetch failure', async () => {
    const password = 's3cret-password';
    const basic = Buffer.from(`operator:${password}`).toString('base64');
    for (const [header, echoed] of [
      [`Bearer ${KEY}`, KEY],
      [`Basic ${basic}`, password],
    ] as const) {
      const fake = new FakeFetch().route('https://node.example', () => {
        throw new TypeError('fetch failed', {
          cause: new Error(`proxy refused credentials ${echoed}`),
        });
      });
      const { transport, clock, seen } = setup(
        [
          {
            name: 'auth',
            url: 'https://node.example/rpc',
            headers: { authorization: secret(header) },
          },
        ],
        fake,
      );
      const { error, text } = await surfaces(
        () => drive(clock, transport.rpc('x')),
        seen,
      );
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expectNoKey(text, echoed);
    }
  });

  it('scrubs a query-string key in its decoded and encoded forms', async () => {
    const key = 'k3y+with/slash=and-more';
    const fake = new FakeFetch().route('https://toncenter.example', () => ({
      status: 400,
      text: `bad api_key ${key} (${encodeURIComponent(key)})`,
    }));
    const { transport, clock, seen } = setup(
      [
        {
          name: 'custom',
          url: `https://toncenter.example/api/v2?api_key=${encodeURIComponent(key)}`,
        },
      ],
      fake,
    );
    const { text } = await surfaces(
      () =>
        drive(
          clock,
          transport.http({ method: 'POST', path: '/jsonRPC', route: '/jsonRPC' }),
        ),
      seen,
    );
    expectNoKey(text, key);
    expectNoKey(text, encodeURIComponent(key));
  });

  it('keeps ordinary words of the URL in node texts the drivers classify', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: {
        jsonrpc: '2.0',
        id: id(req),
        error: {
          code: -32601,
          message: 'the method eth_getBlockReceipts does not exist',
        },
      },
    }));
    const { transport, clock } = setup(
      [{ name: 'ankr', url: secret(`https://node.example/eth/${KEY}`) }],
      fake,
    );
    await expect(
      drive(clock, transport.rpc('eth_getBlockReceipts')),
    ).rejects.toMatchObject({
      details: { rpcMessage: 'the method eth_getBlockReceipts does not exist' },
    });
  });

  it('scrubs a key a provider answers to the identity probe with', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: { jsonrpc: '2.0', id: id(req), result: KEY },
    }));
    const { transport, clock, seen } = setup([pathKeyed], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    const { error, text } = await surfaces(() => drive(clock, transport.rpc('x')), seen);
    expect(error).toMatchObject({ code: 'PROVIDER_MISCONFIGURED' });
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'provider.misconfigured', actual: 'REDACTED' }),
    );
    expectNoKey(text);
  });
});
