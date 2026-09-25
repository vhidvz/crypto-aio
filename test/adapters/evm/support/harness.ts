import { EthersClient } from '../../../../src/adapters/evm/ethers-client';
import type { EvmClient } from '../../../../src/adapters/evm/types';
import { Web3Client } from '../../../../src/adapters/evm/web3-client';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { Transport, TransportOptions } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { ScriptedEvmNode, type NodeOptions } from './node';

export type Library = 'ethers' | 'web3';
export const LIBRARIES: readonly Library[] = ['ethers', 'web3'];

export function makeClient(
  library: Library,
  transport: Transport,
  chainId: bigint,
): EvmClient {
  return library === 'ethers'
    ? new EthersClient(transport, chainId)
    : new Web3Client(transport, chainId);
}

/** A scripted node behind a real HttpTransport, with one or more endpoints. */
export function nodeTransport(
  options: Omit<NodeOptions, 'clock'>,
  endpoints: readonly string[] = ['main'],
  transportOptions: Omit<TransportOptions, 'fetch'> = {},
) {
  const clock = new FakeClock();
  const node = new ScriptedEvmNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = new HttpTransport(
    endpoints.map((name) => ({ name, url: node.endpoint(name) })),
    {
      clock,
      events,
      log: noopLogger,
      options: {
        fetch: node.fetch.fetch,
        baseDelayMs: 1,
        maxDelayMs: 2,
        ...transportOptions,
      },
    },
  );
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, run, seen };
}
