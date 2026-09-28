/** A TON driver context for a built-in network, over the scripted toncenter node. */
import { TON_CHAINS } from '../../../../src/adapters/ton/chains';
import { tonNetworkConfig } from '../../../../src/adapters/ton/network';
import {
  createTonContext,
  createTonExt,
  createTonReader,
  createTonSequence,
} from '../../../../src/adapters/ton/reader';
import { noopLogger } from '../../../../src/core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../../../src/core/model/chain';
import { tonNode } from './harness';
import type { TonNodeOptions } from './node';

export function tonHarness(
  options: {
    readonly network?: 'mainnet' | 'testnet';
    readonly node?: Omit<TonNodeOptions, 'clock' | 'globalId'>;
    readonly endpoints?: readonly string[];
    readonly maxLagBlocks?: number;
  } = {},
) {
  const networkId = options.network ?? 'testnet';
  const chain = TON_CHAINS[0] as ChainInfo;
  const network = chain.networks[networkId] as NetworkInfo;
  const config = tonNetworkConfig(chain, network);
  const t = tonNode(
    { ...options.node, globalId: config.globalId },
    options.endpoints,
    options.maxLagBlocks,
  );
  const ctx = createTonContext({
    api: t.api,
    chain,
    network,
    config,
    log: noopLogger,
    clock: t.clock,
  });
  return {
    ...t,
    chain,
    network,
    config,
    ctx,
    reader: createTonReader(ctx),
    sequence: createTonSequence(ctx),
    ext: createTonExt(ctx),
  };
}
