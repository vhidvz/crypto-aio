import { Wallet } from 'ethers';
import { EVM_CHAINS } from '../../../../src/adapters/evm/chains';
import { evmNetworkConfig } from '../../../../src/adapters/evm/network';
import type { EvmContext } from '../../../../src/adapters/evm/reader';
import type { EvmCallTags, EvmClient } from '../../../../src/adapters/evm/types';
import { noopLogger } from '../../../../src/core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../../../src/core/model/chain';
import { makeClient, nodeTransport, type Library } from './harness';
import type { NodeOptions } from './node';
import { KEY, KEY_ADDRESS, KEY_PUBLIC, RECIPIENT } from './vectors';

/** Wraps a client and records every I/O call's method name and tags (R41). */
export function recording(client: EvmClient) {
  const calls: { method: string; tags: EvmCallTags }[] = [];
  const IO = new Set([
    'blockNumber',
    'getBalance',
    'getTransactionCount',
    'call',
    'estimateGas',
    'gasPrice',
    'feeHistory',
    'getBlock',
    'getBlockWithTransactions',
    'getTransaction',
    'getReceipt',
    'getBlockReceipts',
    'getLogs',
    'sendRawTransaction',
  ]);
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      // Methods run on the real client, whose private fields a Proxy receiver cannot reach.
      if (typeof prop !== 'string' || !IO.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        const { signal: _signal, ...tags } = args[args.length - 1] as EvmCallTags;
        calls.push({ method: prop, tags });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { client: proxy, calls };
}

/** An EVM driver context for a built-in network, over a scripted node. */
export function evmHarness(
  library: Library,
  chainId = 'ethereum',
  networkId = 'sepolia',
  options: {
    readonly endpoints?: readonly string[];
    readonly node?: Partial<Omit<NodeOptions, 'clock' | 'chainId'>>;
  } = {},
) {
  const chain = EVM_CHAINS.find((c) => c.id === chainId) as ChainInfo;
  const network = chain.networks[networkId] as NetworkInfo;
  const config = evmNetworkConfig(chain, network);
  const t = nodeTransport(
    { chainId: config.chainId, ...options.node },
    options.endpoints,
  );
  const { client, calls } = recording(makeClient(library, t.transport, config.chainId));
  const ctx: EvmContext = { client, chain, network, config, log: noopLogger };
  const keys = [{ scheme: 'secp256k1-ecdsa', publicKey: KEY_PUBLIC }];
  return { ...t, client, calls, ctx, keys, from: KEY_ADDRESS };
}

/** Signs with the test key (ethers wallet) and submits through the harness client. */
export async function submit(
  h: ReturnType<typeof evmHarness>,
  nonce: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const wallet = new Wallet(`0x${KEY}`);
  const legacy = h.ctx.config.feeModel === 'evm-legacy';
  const raw = await wallet.signTransaction({
    chainId: h.ctx.config.chainId,
    nonce,
    to: RECIPIENT,
    value: 1_000n,
    gasLimit: 21_000n,
    ...(legacy
      ? { type: 0, gasPrice: 5_000_000_000n }
      : { type: 2, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    ...extra,
  });
  return h.run(
    h.client.sendRawTransaction(raw, {
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
    }),
  );
}
