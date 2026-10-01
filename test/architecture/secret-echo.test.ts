// F3-R20, a release blocker: every family's keyed presets, and custom URLs, with the key
// echoed back by the provider in every place the transport copies provider text.
import { inspect } from 'node:util';
import { EVM_PRESETS } from '../../src/adapters/evm/presets';
import { SOLANA_PRESETS } from '../../src/adapters/solana/presets';
import { TON_PRESETS } from '../../src/adapters/ton/presets';
import { TRON_PRESETS } from '../../src/adapters/tron/presets';
import type { ProviderPreset } from '../../src/core/registry/providers';
import { secret } from '../../src/core/secret/secret';
import type { EndpointConfig } from '../../src/core/transport/types';
import { drive } from '../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../src/testing/fake-fetch';
import { setup } from '../core/transport/support';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

interface Case {
  readonly title: string;
  readonly endpoints: readonly EndpointConfig[];
  readonly style: 'json-rpc' | 'rest';
}

function preset(
  list: readonly ProviderPreset[],
  name: string,
  chain: string,
  network: string,
  kind: 'rpc' | 'indexer' = 'rpc',
): readonly EndpointConfig[] {
  const found = list.find((p) => p.name === name && p.kind === kind);
  if (!found) throw new Error(`no preset ${name}`);
  return found.endpoints({ chain, network, apiKey: secret(KEY) });
}

const CASES: readonly Case[] = [
  ...['alchemy', 'infura', 'ankr'].map((name): Case => ({
    title: `EVM ${name}`,
    endpoints: preset(EVM_PRESETS, name, 'ethereum', 'mainnet'),
    style: 'json-rpc',
  })),
  ...['alchemy', 'infura', 'ankr'].map((name): Case => ({
    title: `Solana ${name}`,
    endpoints: preset(SOLANA_PRESETS, name, 'solana', 'mainnet'),
    style: 'json-rpc',
  })),
  ...(['rpc', 'indexer'] as const).map((kind): Case => ({
    title: `Tron trongrid (${kind})`,
    endpoints: preset(TRON_PRESETS, 'trongrid', 'tron', 'mainnet', kind),
    style: 'rest',
  })),
  ...(['rpc', 'indexer'] as const).map((kind): Case => ({
    title: `TON toncenter (${kind})`,
    endpoints: preset(TON_PRESETS, 'toncenter', 'ton', 'mainnet', kind),
    style: 'rest',
  })),
  {
    title: 'TON custom URL with an api_key query value',
    endpoints: [
      { name: 'custom', url: `https://toncenter.example/api/v2?api_key=${KEY}` },
    ],
    style: 'rest',
  },
  {
    title: 'Bitcoin custom Esplora with a key path segment',
    endpoints: [{ name: 'esplora', url: secret(`https://esplora.example/${KEY}/api`) }],
    style: 'rest',
  },
];

const origin = (endpoint: EndpointConfig) => {
  const url = endpoint.url;
  return new URL(typeof url === 'string' ? url : url.reveal()).origin;
};

function echo(style: Case['style'], req: FakeRequest): FakeReply {
  if (style === 'rest')
    return { status: 400, text: `{"Error":"api key ${KEY} refused"}` };
  return {
    json: {
      jsonrpc: '2.0',
      id: req.json<{ id: unknown }>().id,
      error: { code: -32000, message: `invalid api key ${KEY}`, data: `key=${KEY}` },
    },
  };
}

describe('a key echoed by the provider never reaches an error, a cause or an event', () => {
  it.each(CASES)('$title', async ({ endpoints, style }) => {
    for (const mode of ['answer', 'network'] as const) {
      const fake = new FakeFetch();
      for (const endpoint of endpoints) {
        fake.route(origin(endpoint), (req) => {
          if (mode === 'network') {
            throw new TypeError('fetch failed', { cause: new Error(`refused ${KEY}`) });
          }
          return echo(style, req);
        });
      }
      const { transport, clock, seen } = setup([...endpoints], fake);
      const call =
        style === 'json-rpc'
          ? transport.rpc('getHealth')
          : transport.http({ method: 'POST', path: '/wallet/getnowblock', route: '/x' });
      const error = await drive(clock, call).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: mode === 'answer' ? 'RPC_ERROR' : 'PROVIDER_UNAVAILABLE',
      });
      for (const text of [
        inspect(error, { depth: 10 }),
        JSON.stringify(error),
        JSON.stringify(seen),
        JSON.stringify(transport.status()),
      ]) {
        expect(text.toLowerCase()).not.toContain(KEY.toLowerCase());
      }
    }
  });
});
