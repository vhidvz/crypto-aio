/**
 * An Avalanche driver context over the scripted node, behind real `HttpTransport`s (one for
 * the node's endpoints, one for the Data API). The transports have fixed ids and jitter, so
 * nothing falls back to `Math.random` (lesson 1, R46).
 */
import { AvalancheNode, DataApi } from '../../../../src/adapters/avalanche/api';
import {
  LocationCache,
  type AvalancheContext,
} from '../../../../src/adapters/avalanche/context';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { WalletKey } from '../../../../src/core/driver/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { CallOptions, Transport } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { ScriptedAvalancheNode, type ScriptedAvalancheNodeOptions } from './node';
import {
  TEST_BYTES,
  TEST_PUBKEY,
  chainOf,
  configOf,
  networkOf,
  type Vm,
} from './vectors';
import { formatAddress } from '../../../../src/adapters/avalanche/address';

/** Records each JSON-RPC method and its tags (signal and quorum key reduced to flags). */
export function recording(transport: Transport) {
  const calls: { method: string; tags: Record<string, unknown> }[] = [];
  const reduce = (options: CallOptions = {}) => {
    const { signal, quorumKey, ...tags } = options;
    return {
      ...tags,
      ...(signal ? { signal: true } : {}),
      ...(quorumKey ? { quorumKey: true } : {}),
    };
  };
  const recorded: Transport = {
    get id() {
      return transport.id;
    },
    get maxLagBlocks() {
      return transport.maxLagBlocks;
    },
    rpc: (method, params, options) => {
      calls.push({ method, tags: reduce(options) });
      return transport.rpc(method, params, options);
    },
    rpcRaw: (payload, options) => transport.rpcRaw(payload, options),
    http: (request, options) => {
      calls.push({
        method: `GET ${request.route ?? request.path}`,
        tags: reduce(options),
      });
      return transport.http(request, options);
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

export interface HarnessOptions {
  readonly vm?: Vm;
  readonly endpoints?: readonly (
    string | { readonly name: string; readonly lag?: number }
  )[];
  readonly node?: Partial<Omit<ScriptedAvalancheNodeOptions, 'clock' | 'vm'>>;
  readonly driverOptions?: Readonly<Record<string, unknown>>;
  /** Proof quorum of the node transport (default: the transport's, 2). */
  readonly proofQuorum?: number;
}

export function avalancheHarness(options: HarnessOptions = {}) {
  const vm = options.vm ?? 'avm';
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedAvalancheNode({ clock, vm, ...options.node });
  const events = new EventBus(clock, noopLogger);
  const transportOptions = {
    fetch: node.fetch.fetch,
    baseDelayMs: 1,
    maxDelayMs: 2,
    ...(options.proofQuorum !== undefined ? { proofQuorum: options.proofQuorum } : {}),
  };
  const endpoints = (options.endpoints ?? ['main']).map((entry) =>
    typeof entry === 'string' ? { name: entry } : entry,
  );
  const rpc = new HttpTransport(
    endpoints.map((e) => ({
      name: e.name,
      url: node.endpoint(e.name, { lag: e.lag ?? 0 }),
    })),
    {
      clock,
      events,
      log: noopLogger,
      id: 'avalanche-test',
      random: () => 0.5,
      options: transportOptions,
    },
  );
  const indexerTransport = new HttpTransport(
    [{ name: 'data', url: node.indexer('data'), kind: 'indexer' }],
    {
      clock,
      events,
      log: noopLogger,
      id: 'avalanche-indexer-test',
      random: () => 0.5,
      options: transportOptions,
    },
  );
  const recorded = recording(rpc);
  const indexer = recording(indexerTransport);
  const config = configOf(vm, options.driverOptions);
  const ctx: AvalancheContext = {
    node: new AvalancheNode(recorded.transport, vm),
    dataApi: new DataApi(indexer.transport),
    chain: chainOf(vm),
    network: networkOf(vm),
    config,
    clock,
    log: noopLogger,
    located: new LocationCache(),
  };
  const keys: WalletKey[] = [{ scheme: 'secp256k1-ecdsa', publicKey: TEST_PUBKEY }];
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return {
    vm,
    clock,
    node,
    ctx,
    config,
    keys,
    run,
    calls: recorded.calls,
    indexerCalls: indexer.calls,
    transport: recorded.transport,
    indexer: indexer.transport,
    from: formatAddress(TEST_BYTES, config),
    address: (bytes: Uint8Array) => formatAddress(bytes, config),
  };
}

export type Harness = ReturnType<typeof avalancheHarness>;
