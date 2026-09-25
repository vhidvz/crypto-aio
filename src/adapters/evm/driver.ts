/**
 * `EvmDriver` (spec §15): all EVM logic, over the `EvmClient` strategy. One factory serves
 * every EVM chain and network; each network's registry data configures it.
 */
import type { ChainDriver, DriverFactory } from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import type { EndpointCall, HealthProbes, Transport } from '../../core/transport/types';
import { createEvmBroadcaster, createEvmBuilder, createEvmReplacement } from './builder';
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

async function quantity(call: EndpointCall, method: string): Promise<bigint> {
  const value = await call.rpc<unknown>(method);
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', `malformed ${method} answer`);
  }
  return BigInt(value);
}

/** R19: identity is the decimal `eth_chainId`; the height is `eth_blockNumber`. */
function probes(expectedIdentity: string | undefined): HealthProbes {
  return {
    identity: async (call) => (await quantity(call, 'eth_chainId')).toString(),
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
    height: (call) => quantity(call, 'eth_blockNumber'),
  };
}

export function evmDriverFactory(
  makeClient: (transport: Transport, chainId: bigint) => EvmClient,
): DriverFactory {
  return {
    async create(ctx): Promise<ChainDriver> {
      const config = evmNetworkConfig(ctx.chain, ctx.network);
      // M12: probes go on every transport this driver receives, before any traffic.
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
        broadcaster: createEvmBroadcaster(client),
        proofs: createEvmProofs(evm),
        sequence: createEvmSequence(client),
        ...(replacement ? { replacement } : {}),
        blocks: createEvmBlocks(evm),
        ext: { evm: { getNonce: ext.evm.getNonce } },
        limits: () => ({ maxOutputs: 1 }),
        // R34: a fresh SDK client on every call, never the driver's own.
        createNativeClient: () => client.createNative(),
      };
    },
  };
}
