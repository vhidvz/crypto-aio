import { SOLANA_CHAIN } from '../../../../src/adapters/solana/chains';
import { HeightIndex } from '../../../../src/adapters/solana/heights';
import { solanaNetworkConfig } from '../../../../src/adapters/solana/network';
import type { SolanaContext } from '../../../../src/adapters/solana/reader';
import type { SolanaCallTags } from '../../../../src/adapters/solana/types';
import { createWeb3Codec } from '../../../../src/adapters/solana/web3';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import type { NetworkInfo } from '../../../../src/core/model/chain';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { Transport } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import {
  ScriptedSolanaNode,
  type BalancedOptions,
  type EndpointOptions,
  type NodeOptions,
} from './node';
import { KEY_ADDRESS, KEY_PUBLIC } from './vectors';

export type Endpoint =
  string | ({ readonly name: string } & (EndpointOptions | BalancedOptions));

/** A scripted node behind a real HttpTransport, with one or more endpoints. */
export function nodeTransport(
  options: Omit<NodeOptions, 'clock'> = {},
  endpoints: readonly Endpoint[] = ['main'],
) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = new HttpTransport(
    endpoints.map((entry) => {
      const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
      return { name, url: node.endpoint(name, rest) };
    }),
    {
      clock,
      events,
      log: noopLogger,
      // A fixed id and jitter, or the core falls back to random ones.
      id: 'solana-test',
      random: () => 0.5,
      options: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    },
  );
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, run, seen };
}

/** Records every JSON-RPC call's method, tags and params, passing it through. */
export function recording(transport: Transport) {
  const calls: { method: string; tags: SolanaCallTags; params: unknown }[] = [];
  const rpc = (
    method: string,
    params: unknown,
    options: Record<string, unknown> = {},
  ) => {
    const { signal: _signal, quorumKey: _key, exactIntegers: _exact, ...tags } = options;
    calls.push({ method, tags: tags as SolanaCallTags, params });
    return transport.rpc(method, params, options);
  };
  // Methods run on the real transport, whose private fields a Proxy receiver cannot reach.
  const wrapped = new Proxy(transport, {
    get(target, prop) {
      if (prop === 'rpc') return rpc;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { transport: wrapped, calls };
}

/** A Solana driver context for devnet over a scripted node. */
export function solanaHarness(
  options: {
    readonly endpoints?: readonly Endpoint[];
    readonly node?: Omit<NodeOptions, 'clock'>;
  } = {},
) {
  const t = nodeTransport(options.node, options.endpoints);
  const network = SOLANA_CHAIN.networks.devnet as NetworkInfo;
  const { transport, calls } = recording(t.transport);
  const ctx: SolanaContext = {
    transport,
    codec: createWeb3Codec(t.transport),
    chain: SOLANA_CHAIN,
    network,
    config: solanaNetworkConfig(SOLANA_CHAIN, network),
    heights: new HeightIndex(transport),
    log: noopLogger,
    nextVariant: () => 0,
  };
  const keys = [{ scheme: 'ed25519', publicKey: KEY_PUBLIC }];
  return { ...t, ctx, calls, keys, from: KEY_ADDRESS };
}
