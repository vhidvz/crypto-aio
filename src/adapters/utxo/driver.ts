/**
 * The UTXO driver factory: validated network config, endpoint probes on both transports,
 * and the ports (spec §7). Loaded only by the manifest's `load()`, with bitcoinjs-lib.
 */
import type { ChainDriver, DriverContext, DriverFactory } from '../../core/driver/types';
import { ConfigError } from '../../core/errors/error';
import type { EndpointCall, HealthProbes } from '../../core/transport/types';
import { utxoBroadcaster, utxoBuilder, utxoReplacement } from './builder';
import { networkOf } from './codec';
import { READ, type UtxoContext } from './context';
import { EsploraClient, parseHash, parseHeight } from './esplora';
import { utxoNetworkConfig } from './network';
import { blockSource, proofSource } from './proofs';
import { addressCodec, addressHistory, chainReader, listUnspent } from './reader';
import { bitcoin, useNobleEcc } from './sdk';
import { coinSelectionPreview } from './preview';
import { MAX_OUTPUTS } from './spend';
import type { UtxoExt } from './types';

export interface UtxoNativeClient {
  /** The bitcoinjs-lib module, with this library's `@noble/curves` ECC backend installed. */
  readonly bitcoin: typeof bitcoin;
  /** A fresh copy of this network's bitcoinjs parameters. */
  readonly network: ReturnType<typeof networkOf>;
  /** A GET to the handle's Esplora (`rpc`) endpoints, through the policy-wrapped transport. */
  esplora<T = unknown>(path: string, responseType?: 'json' | 'text'): Promise<T>;
}

function probes(expectedIdentity: string): HealthProbes {
  const text = (call: EndpointCall, path: string, route: string) =>
    call.http<string>({ method: 'GET', path, route, responseType: 'text' });
  return {
    identity: async (call) =>
      parseHash(await text(call, '/block-height/0', '/block-height/:height')),
    expectedIdentity,
    height: async (call) =>
      parseHeight(await text(call, '/blocks/tip/height', '/blocks/tip/height')),
  };
}

export const utxoDriverFactory: DriverFactory = {
  async create(ctx: DriverContext): Promise<ChainDriver> {
    const config = utxoNetworkConfig(ctx.chain, ctx.network, ctx.options);
    if (!ctx.indexer) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'the UTXO driver requires an indexer provider',
      );
    }
    // M12: both transports, before any traffic.
    ctx.transport.setProbes(probes(config.genesisHash));
    ctx.indexer.setProbes(probes(config.genesisHash));
    const esplora = new EsploraClient(ctx.transport, ctx.indexer);
    const utxo: UtxoContext = {
      esplora,
      chain: ctx.chain,
      network: ctx.network,
      config,
      log: ctx.log,
    };
    const network = networkOf(config.address);
    const builder = utxoBuilder(utxo, network);
    return {
      ordering: 'inputs',
      capabilities: config.capabilities,
      address: addressCodec(utxo),
      reader: chainReader(utxo),
      builder,
      broadcaster: utxoBroadcaster(utxo),
      proofs: proofSource(utxo),
      replacement: utxoReplacement(utxo, network),
      blocks: blockSource(utxo),
      history: addressHistory(utxo),
      ext: {
        utxo: {
          listUnspent: (address: string) => listUnspent(utxo, address),
          coinSelection: (request: Parameters<UtxoExt['utxo']['coinSelection']>[0]) =>
            coinSelectionPreview(utxo, request),
        },
      } satisfies UtxoExt,
      limits: () => ({ maxOutputs: MAX_OUTPUTS }),
      createNativeClient: () => {
        // The doc's promise: taproot works on this module (and a swapped backend is undone).
        useNobleEcc();
        const client: UtxoNativeClient = {
          bitcoin,
          network: { ...network, bip32: { ...network.bip32 } },
          esplora: <T>(path: string, responseType: 'json' | 'text' = 'json') =>
            ctx.transport.http<T>(
              { method: 'GET', path, route: '/native', responseType },
              READ,
            ),
        };
        return { client };
      },
    };
  },
};
