import type { SolanaCallTags } from '../../../../src/adapters/solana/types';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { Transport } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import {
  ScriptedSolanaNode,
  type BalancedOptions,
  type EndpointOptions,
  type NodeOptions,
} from './node';

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
      // Lesson 1, R46: a fixed id and jitter, or the core falls back to random ones.
      id: 'solana-test',
      random: () => 0.5,
      options: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    },
  );
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, run, seen };
}

/** Records every JSON-RPC call's method, tags and params (lesson 1), passing it through. */
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
