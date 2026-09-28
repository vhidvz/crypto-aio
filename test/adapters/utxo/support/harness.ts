/**
 * The UTXO ports over the scripted Esplora node through real transports (rpc and indexer),
 * recording every call's HTTP request and tags, for the port-level suites.
 */
import { BITCOIN_CHAIN } from '../../../../src/adapters/utxo/chains';
import { networkOf } from '../../../../src/adapters/utxo/codec';
import type { UtxoContext } from '../../../../src/adapters/utxo/context';
import { utxoDriverFactory } from '../../../../src/adapters/utxo/driver';
import { EsploraClient } from '../../../../src/adapters/utxo/esplora';
import { utxoNetworkConfig } from '../../../../src/adapters/utxo/network';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { NetworkInfo } from '../../../../src/core/model/chain';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type {
  CallOptions,
  HttpRequest,
  Transport,
} from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { ScriptedEsploraNode, type ScriptedEsploraNodeOptions } from './node';

export const REGTEST_NETWORK = BITCOIN_CHAIN.networks.regtest as NetworkInfo;

export interface RecordedCall {
  readonly transport: 'rpc' | 'indexer';
  readonly request: HttpRequest;
  readonly options: CallOptions;
}

/** Passes calls through, recording each HTTP request and its tags. */
function recording(
  inner: Transport,
  name: 'rpc' | 'indexer',
  calls: RecordedCall[],
): Transport {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'http') {
        return (request: HttpRequest, options: CallOptions = {}) => {
          calls.push({ transport: name, request, options });
          return target.http(request, options);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export interface HarnessOptions {
  readonly endpoints?: readonly string[];
  readonly node?: Omit<Partial<ScriptedEsploraNodeOptions>, 'clock'>;
  /** The handle `options` (driver options). */
  readonly options?: Readonly<Record<string, unknown>>;
}

export async function utxoHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const node = new ScriptedEsploraNode({ clock, ...options.node });
  const urls = (options.endpoints ?? ['a']).map((name) => ({
    name,
    url: node.endpoint(name),
  }));
  const events = new EventBus(clock, noopLogger);
  const make = (id: string) =>
    new HttpTransport(urls, {
      clock,
      events,
      log: noopLogger,
      id,
      // Determinism (lesson 1, R46): no Math.random in backoff jitter.
      random: () => 0.5,
      options: {
        fetch: node.fetch.fetch,
        baseDelayMs: 1,
        maxDelayMs: 2,
        timeoutMs: 5_000,
      },
    });
  const calls: RecordedCall[] = [];
  const transport = recording(make('rpc'), 'rpc', calls);
  const indexer = recording(make('idx'), 'indexer', calls);
  const config = utxoNetworkConfig(BITCOIN_CHAIN, REGTEST_NETWORK, options.options ?? {});
  const ctx: UtxoContext = {
    esplora: new EsploraClient(transport, indexer),
    chain: BITCOIN_CHAIN,
    network: REGTEST_NETWORK,
    config,
    log: noopLogger,
  };
  const network = networkOf(config.address);
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise, 100);
  return { clock, node, ctx, network, transport, indexer, calls, run, options };
}

export type Harness = Awaited<ReturnType<typeof utxoHarness>>;

/** The whole driver from the factory, over the harness's two transports (Task 9). */
export async function withDriver(h: Harness) {
  return utxoDriverFactory.create({
    chain: BITCOIN_CHAIN,
    network: REGTEST_NETWORK,
    library: 'bitcoinjs-lib',
    transport: h.transport,
    indexer: h.indexer,
    clock: h.clock,
    log: noopLogger,
    options: h.options.options ?? {},
  });
}
