import { TronApi } from '../../../../src/adapters/tron/http';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type {
  CallOptions,
  HttpRequest,
  Transport,
} from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { ScriptedTronNode, type NodeOptions } from './node';

/** Records each HTTP call's path and tags (signal and quorum key reduced to flags). */
export function recording(transport: Transport) {
  const calls: { path: string; tags: Record<string, unknown> }[] = [];
  const recorded: Transport = {
    get id() {
      return transport.id;
    },
    get maxLagBlocks() {
      return transport.maxLagBlocks;
    },
    rpc: (method, params, options) => transport.rpc(method, params, options),
    rpcRaw: (payload, options) => transport.rpcRaw(payload, options),
    http: <T>(request: HttpRequest, options: CallOptions = {}): Promise<T> => {
      const { signal, quorumKey, ...tags } = options;
      calls.push({
        path: request.path,
        tags: {
          ...tags,
          ...(signal ? { signal: true } : {}),
          ...(quorumKey ? { quorumKey: true } : {}),
        },
      });
      return transport.http<T>(request, options);
    },
    createFetch: (classify) => transport.createFetch(classify),
    setProbes: (probes) => transport.setProbes(probes),
    hasProbes: () => transport.hasProbes(),
    refreshHealth: (signal) => transport.refreshHealth(signal),
    ensureFreshHealth: (signal) => transport.ensureFreshHealth(signal),
    status: () => transport.status(),
    highestHeight: () => transport.highestHeight(),
  };
  return { transport: recorded, calls };
}

/**
 * A scripted node behind a real HttpTransport, with one or more endpoints. The transport has
 * a fixed id and jitter source, so nothing falls back to `Math.random`.
 */
export function nodeTransport(
  options: Partial<Omit<NodeOptions, 'clock'>> = {},
  endpoints: readonly string[] = ['main'],
) {
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedTronNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const http = new HttpTransport(
    endpoints.map((name) => ({ name, url: node.endpoint(name) })),
    {
      clock,
      events,
      log: noopLogger,
      id: 'tron-test',
      random: () => 0.5,
      options: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    },
  );
  const { transport, calls } = recording(http);
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, calls, run, seen, api: new TronApi(transport) };
}
