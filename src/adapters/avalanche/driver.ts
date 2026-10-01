/**
 * The Avalanche driver factory: validated network config, endpoint probes on both
 * transports, and the ports. Loaded only by the manifest's `load()`, with
 * `@avalabs/avalanchejs`.
 */
import type { ChainDriver, DriverContext, DriverFactory } from '../../core/driver/types';
import { ConfigError } from '../../core/errors/error';
import type { EndpointCall, HealthProbes } from '../../core/transport/types';
import { AvalancheNode, DataApi, parseBlock, parseHeight } from './api';
import { avalancheBroadcaster, avalancheBuilder, MAX_OUTPUTS } from './builder';
import { sdkContext } from './codec';
import { LocationCache, READ, type AvalancheContext } from './context';
import { avalancheNetworkConfig, type AvalancheNetworkConfig } from './network';
import { blockSource, proofSource } from './proofs';
import { addressCodec, addressHistory, chainReader, listUnspent } from './reader';
import { avalanche, type AvalancheSdk, type SdkContext } from './sdk';
import type { AvalancheExt } from './types';

export interface AvalancheNativeClient {
  /**
   * The `@avalabs/avalanchejs` module. Its type names the members this library uses; cast
   * it to reach the rest of the SDK.
   */
  readonly avalanche: AvalancheSdk;
  /**
   * avalanchejs's `Context` for this network and chain (network id, HRP, AVAX asset id,
   * this chain's id). Its fee fields are zero: read the fees from the chain.
   */
  readonly context: SdkContext;
  /** A JSON-RPC call (e.g. `avm.getTxFee`) to the handle's node endpoints, through the transport. */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
}

function nodeProbes(config: AvalancheNetworkConfig): HealthProbes {
  const prefix = config.vm === 'avm' ? 'avm' : 'platform';
  return {
    identity: async (call: EndpointCall) =>
      parseBlock(
        await call.rpc(`${prefix}.getBlockByHeight`, { height: '0', encoding: 'json' }),
      ).id,
    expectedIdentity: config.genesisBlockId,
    height: async (call: EndpointCall) =>
      parseHeight(
        ((await call.rpc(`${prefix}.getHeight`, {})) as { height?: unknown } | null)
          ?.height,
      ),
  };
}

function indexerProbes(config: AvalancheNetworkConfig): HealthProbes {
  return {
    identity: async (call: EndpointCall) =>
      DataApi.blockZero(
        await call.http({ method: 'GET', path: '/blocks/0', route: '/blocks/:id' }),
      ),
    expectedIdentity: config.genesisBlockId,
    height: async (call: EndpointCall) =>
      DataApi.latestHeight(
        await call.http({
          method: 'GET',
          path: '/blocks',
          query: { pageSize: '1' },
          route: '/blocks',
        }),
      ),
  };
}

export const avalancheDriverFactory: DriverFactory = {
  async create(ctx: DriverContext): Promise<ChainDriver> {
    const config = avalancheNetworkConfig(ctx.chain, ctx.network, ctx.options);
    if (!ctx.indexer) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'the Avalanche driver requires an indexer provider (the Avalanche Data API)',
      );
    }
    // Probes on both transports, once, before any traffic: without them an endpoint's
    // identity is never checked, and an endpoint of another network is never disabled.
    ctx.transport.setProbes(nodeProbes(config));
    ctx.indexer.setProbes(indexerProbes(config));
    const avax: AvalancheContext = {
      node: new AvalancheNode(ctx.transport, config.vm),
      dataApi: new DataApi(ctx.indexer),
      chain: ctx.chain,
      network: ctx.network,
      config,
      clock: ctx.clock,
      log: ctx.log,
      located: new LocationCache(),
    };
    return {
      ordering: 'inputs',
      capabilities: config.capabilities,
      address: addressCodec(avax),
      reader: chainReader(avax),
      builder: avalancheBuilder(avax),
      broadcaster: avalancheBroadcaster(avax),
      proofs: proofSource(avax),
      blocks: blockSource(avax),
      history: addressHistory(avax),
      ext: {
        avalanche: {
          listUnspent: (address: string) => listUnspent(avax, address),
        },
      } satisfies AvalancheExt,
      limits: () => ({ maxOutputs: MAX_OUTPUTS }),
      createNativeClient: () => {
        const client: AvalancheNativeClient = {
          avalanche,
          context: sdkContext(config),
          rpc: <T>(method: string, params?: unknown) =>
            ctx.transport.rpc<T>(method, params ?? {}, READ),
        };
        return { client };
      },
    };
  },
};
