/**
 * The Tron driver factory (spec §7), for any `TronCodec`: validates the network and options,
 * configures the identity (block 0's id) and height probes exactly once on every transport it
 * receives, before any traffic (M12, R19), and assembles the ports. `address-history` needs
 * an indexer transport (TronGrid's `/v1`). This module imports no SDK: the codec module
 * exports the library's factory (`tronwebDriverFactory`), so there is no import cycle.
 */
import type { ChainDriver, DriverFactory } from '../../core/driver/types';
import type { Capability } from '../../core/model/capability';
import type { EndpointCall } from '../../core/transport/types';
import { tronAddressCodec } from './address';
import { createTronBuilder } from './builder';
import { TronApi, malformed } from './http';
import {
  TRON_CAPABILITIES,
  TRON_INDEXER_CAPABILITIES,
  tronNetworkConfig,
} from './network';
import { createTronBlocks, createTronHistory, createTronProofs } from './proofs';
import { createTronExt, createTronReader, type TronContext } from './reader';
import type { TronCodec, TronExt } from './types';

async function blockField(
  call: EndpointCall,
  path: string,
  body: Record<string, unknown>,
): Promise<{ readonly id: string; readonly number: bigint }> {
  const answer = await call.http<Record<string, unknown>>({
    method: 'POST',
    path,
    body,
    route: path,
  });
  const raw = (answer?.block_header as { raw_data?: { number?: unknown } } | undefined)
    ?.raw_data;
  const id = answer?.blockID;
  const number = raw?.number ?? 0;
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(id) ||
    !Number.isSafeInteger(number)
  ) {
    throw malformed('probe block');
  }
  return { id, number: BigInt(number as number) };
}

export function tronDriverFactory(codec: TronCodec): DriverFactory {
  return {
    async create(ctx): Promise<ChainDriver> {
      const config = tronNetworkConfig(ctx.chain, ctx.network, ctx.options);
      const height = async (call: EndpointCall) =>
        (await blockField(call, '/wallet/getblock', { detail: false })).number;
      // D2: the rpc endpoint must serve the full node, the solidity node and JSON-RPC for one
      // network; a partial endpoint fails its identity check loudly instead of stalling proofs.
      ctx.transport.setProbes({
        identity: async (call) => {
          const full = (await blockField(call, '/wallet/getblockbynum', { num: 0 })).id;
          const solid = (
            await blockField(call, '/walletsolidity/getblockbynum', { num: 0 })
          ).id;
          const rpc = await call.http<{ result?: { hash?: unknown } } | null>({
            method: 'POST',
            path: '/jsonrpc',
            route: '/jsonrpc',
            body: {
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getBlockByNumber',
              params: ['0x0', false],
            },
          });
          const hash = rpc?.result?.hash;
          if (
            solid !== full ||
            typeof hash !== 'string' ||
            hash.toLowerCase() !== `0x${full}`
          ) {
            throw malformed('endpoint services');
          }
          return full;
        },
        expectedIdentity: config.identity,
        height,
      });
      // The indexer (TronGrid's /v1) answers the full-node paths only.
      ctx.indexer?.setProbes({
        identity: async (call) =>
          (await blockField(call, '/wallet/getblockbynum', { num: 0 })).id,
        expectedIdentity: config.identity,
        height,
      });

      const tron: TronContext = {
        api: new TronApi(ctx.transport),
        codec,
        chain: ctx.chain,
        network: ctx.network,
        config,
        clock: ctx.clock,
        log: ctx.log,
      };
      const reader = createTronReader(tron);
      const { builder, broadcaster } = createTronBuilder(tron);
      const capabilities = new Set<Capability>(TRON_CAPABILITIES);
      if (ctx.indexer) for (const c of TRON_INDEXER_CAPABILITIES) capabilities.add(c);
      const ext = createTronExt(tron);
      return {
        ordering: 'expiry',
        capabilities,
        address: tronAddressCodec,
        reader,
        builder,
        broadcaster,
        proofs: createTronProofs(tron),
        blocks: createTronBlocks(tron),
        ...(ctx.indexer
          ? {
              history: createTronHistory(tron, ctx.indexer, (id) =>
                reader.getTransaction(id),
              ),
            }
          : {}),
        ext: { tron: { getResources: ext.tron.getResources } } satisfies TronExt,
        limits: () => ({ maxOutputs: 1 }),
        createNativeClient: () => codec.createNative(ctx.transport),
      };
    },
  };
}
