/**
 * `EvmDriver`: all EVM logic, over the `EvmClient` strategy. One factory serves
 * every EVM chain and network; each network's registry data configures it.
 */
import type { ChainDriver, DriverFactory } from '../../core/driver/types';
import type { EndpointCall, HealthProbes, Transport } from '../../core/transport/types';
import { createEvmBroadcaster, createEvmBuilder, createEvmReplacement } from './builder';
import { quantity } from './client';
import { evmNetworkConfig } from './network';
import { createEvmBlocks, createEvmProofs } from './proofs';
import {
  createEvmAddressCodec,
  createEvmExt,
  createEvmReader,
  createEvmSequence,
  type EvmContext,
} from './reader';
import type { EvmClient } from './types';

const probe = async (call: EndpointCall, method: string): Promise<bigint> =>
  quantity(await call.rpc<unknown>(method), method);

/**
 * Identity is the decimal `eth_chainId`, the form of the network's registry identity; the
 * height is `eth_blockNumber`. Only endpoints whose identity matches feed health heights.
 */
function probes(expectedIdentity: string | undefined): HealthProbes {
  return {
    identity: async (call) => (await probe(call, 'eth_chainId')).toString(),
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
    height: (call) => probe(call, 'eth_blockNumber'),
  };
}

export function evmDriverFactory(
  makeClient: (transport: Transport, chainId: bigint) => EvmClient,
): DriverFactory {
  return {
    async create(ctx): Promise<ChainDriver> {
      // The handle's options too (`maxFeePerGas`); an unknown one is refused, so a
      // misspelt key never passes silently.
      const config = evmNetworkConfig(ctx.chain, ctx.network, ctx.options);
      // Probes go on every transport this driver receives, before any traffic: an
      // endpoint without them stays unverified.
      ctx.transport.setProbes(probes(ctx.network.identity));
      ctx.indexer?.setProbes(probes(ctx.network.identity));
      const client = makeClient(ctx.transport, config.chainId);
      const evm: EvmContext = {
        client,
        chain: ctx.chain,
        network: ctx.network,
        config,
        log: ctx.log,
      };
      const replacement = createEvmReplacement(evm);
      const ext = createEvmExt(client);
      return {
        ordering: 'nonce',
        capabilities: config.capabilities,
        address: createEvmAddressCodec(client),
        reader: createEvmReader(evm),
        builder: createEvmBuilder(evm),
        broadcaster: createEvmBroadcaster(client, config.chainId),
        proofs: createEvmProofs(evm),
        sequence: createEvmSequence(client),
        ...(replacement ? { replacement } : {}),
        blocks: createEvmBlocks(evm),
        ext: { evm: { getNonce: ext.evm.getNonce } },
        limits: () => ({ maxOutputs: 1 }),
        // A fresh SDK client on every call, never the driver's own: a caller may mutate
        // it (listeners, polling) without touching other handles.
        createNativeClient: () => client.createNative(),
      };
    },
  };
}
