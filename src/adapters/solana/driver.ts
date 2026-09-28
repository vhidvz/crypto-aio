/**
 * The Solana driver (spec §15), over the `SolanaCodec` of `@solana/web3.js`. One factory
 * serves every Solana cluster; each network's registry data configures it.
 */
import type { ChainDriver, DriverFactory } from '../../core/driver/types';
import type { EndpointCall, HealthProbes, Transport } from '../../core/transport/types';
import { randomBytes } from '../../core/util/bytes';
import { createSolanaBroadcaster, createSolanaBuilder } from './builder';
import { variantCounter } from './fees';
import { HeightIndex } from './heights';
import { createSolanaHistory } from './history';
import { decodeBase58 } from './keys';
import { solanaNetworkConfig } from './network';
import { createSolanaBlocks, createSolanaProofs } from './proofs';
import {
  createSolanaAddressCodec,
  createSolanaExt,
  createSolanaReader,
  type SolanaContext,
} from './reader';
import { malformed, u64 } from './rpc';
import type { SolanaCodec } from './types';

/** R19: identity is the genesis hash; the height is the `confirmed` block height. */
function probes(genesisHash: string): HealthProbes {
  return {
    identity: async (call: EndpointCall) => {
      const hash = await call.rpc<unknown>('getGenesisHash', []);
      if (decodeBase58(hash, 32) === null) throw malformed('getGenesisHash');
      return hash as string;
    },
    expectedIdentity: genesisHash,
    height: async (call: EndpointCall) =>
      u64(
        await call.rpc<unknown>('getBlockHeight', [{ commitment: 'confirmed' }]),
        'height',
      ),
  };
}

export function solanaDriverFactory(
  makeCodec: (transport: Transport) => SolanaCodec,
): DriverFactory {
  return {
    async create(ctx): Promise<ChainDriver> {
      const config = solanaNetworkConfig(ctx.chain, ctx.network);
      // M12: probes go on every transport this driver receives, before any traffic.
      ctx.transport.setProbes(probes(config.genesisHash));
      ctx.indexer?.setProbes(probes(config.genesisHash));
      const codec = makeCodec(ctx.transport);
      // A random start for the build variants (fees.ts): distinct across processes.
      const seed = randomBytes(4);
      const solana: SolanaContext = {
        transport: ctx.transport,
        codec,
        chain: ctx.chain,
        network: ctx.network,
        config,
        heights: new HeightIndex(ctx.transport),
        log: ctx.log,
        nextVariant: variantCounter(
          new DataView(seed.buffer, seed.byteOffset, 4).getUint32(0),
        ),
      };
      // Handoff §3: history reads the indexer transport when one is configured.
      const history = ctx.indexer
        ? { ...solana, transport: ctx.indexer, heights: new HeightIndex(ctx.indexer) }
        : solana;
      const ext = createSolanaExt(solana);
      return {
        ordering: 'expiry',
        capabilities: config.capabilities,
        address: createSolanaAddressCodec(),
        reader: createSolanaReader(solana),
        builder: createSolanaBuilder(solana),
        broadcaster: createSolanaBroadcaster(solana),
        proofs: createSolanaProofs(solana),
        blocks: createSolanaBlocks(solana),
        history: createSolanaHistory(history),
        ext: { solana: { getTokenAccounts: ext.solana.getTokenAccounts } },
        limits: () => ({ maxOutputs: 1 }),
        // R34: a fresh `Connection` on every call, never a shared one.
        createNativeClient: () => codec.createNative(),
      };
    },
  };
}
