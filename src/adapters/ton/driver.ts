/**
 * The TON driver: one factory for both built-in networks, configured by each network's
 * registry data. The family shape: `tonDriverFactory(makeNative)` lives here and imports
 * no client module; the library's module (`native-client.ts`) supplies the native client
 * and exports the loadable factory.
 */
import type {
  ChainDriver,
  DisposableNativeClient,
  DriverFactory,
  DriverLimits,
  WalletOptions,
} from '../../core/driver/types';
import { ConfigError, ProviderError } from '../../core/errors/error';
import type { EndpointCall, HealthProbes, Transport } from '../../core/transport/types';
import { TonApi, configParamBoc, indexedHeadOf, masterchainInfoSeqno } from './api';
import { createTonBroadcaster, createTonBuilder } from './builder';
import { cellFromBoc } from './messages';
import { tonNetworkConfig } from './network';
import { createTonHistory, createTonProofs } from './proofs';
import {
  createTonContext,
  createTonExt,
  createTonReader,
  createTonSequence,
} from './reader';
import { resolveIdentity } from './wallets';

/** A probe answer that does not parse: the endpoint fails its health check (retryable). */
const malformedProbe = (route: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `malformed toncenter answer to ${route}`, {
    retryable: true,
  });

/**
 * The probes read heights and the indexer's global id with `api.ts`'s own
 * parsers, the ones the proofs use, so the two never drift.
 *
 * v2: identity = config param 19, the network's global id, from a cell that holds
 * exactly one int32 (`global_id#_ global_id:int32 = ConfigParam 19`); height = the
 * liteserver's masterchain head. One call each: each probe takes a token from the
 * endpoint's rate limit.
 */
const rpcProbes = (expectedIdentity: string): HealthProbes => ({
  identity: async (call: EndpointCall) => {
    const route = '/getConfigParam';
    const body = await call.http({
      method: 'GET',
      path: route,
      query: { param: '19' },
      route,
    });
    const cell = cellFromBoc(configParamBoc(body, route));
    const slice = cell && !cell.isExotic ? cell.beginParse() : null;
    if (!slice || slice.remainingBits !== 32 || slice.remainingRefs !== 0) {
      throw malformedProbe(route);
    }
    return String(slice.loadInt(32));
  },
  expectedIdentity,
  height: async (call: EndpointCall) => {
    const route = '/getMasterchainInfo';
    return BigInt(
      masterchainInfoSeqno(await call.http({ method: 'GET', path: route, route }), route),
    );
  },
});

/**
 * v3: identity = the indexed head's `global_id` (an int32); height = the newest
 * indexed masterchain block.
 */
const indexerProbes = (expectedIdentity: string): HealthProbes => {
  const route = '/masterchainInfo';
  const indexedHead = async (call: EndpointCall) =>
    indexedHeadOf(await call.http({ method: 'GET', path: route, route }), route);
  return {
    identity: async (call) => String((await indexedHead(call)).globalId),
    expectedIdentity,
    height: async (call) => BigInt((await indexedHead(call)).seqno),
  };
};

/**
 * A TON transfer carries exactly one output (a partly delivered batch has no safe single
 * verdict: `failed` invites a whole re-send that pays the delivered outputs twice),
 * whatever the wallet version. The core prefers this answer to its own capability
 * default, so it holds even for a selection that somehow lists `batch-transfer`.
 */
const ONE_OUTPUT: DriverLimits = Object.freeze({ maxOutputs: 1 });

/** The batch limit of a wallet; a malformed TON identity throws its `CONFIG_INVALID`. */
function limitsOf(wallet: WalletOptions, globalId: number): DriverLimits {
  if (wallet.ton !== undefined) resolveIdentity(wallet, globalId);
  return ONE_OUTPUT;
}

/** The TON driver factory over a native-client maker (the library module supplies it). */
export const tonDriverFactory = (
  makeNative: (transport: Transport) => DisposableNativeClient,
): DriverFactory => ({
  async create(ctx): Promise<ChainDriver> {
    // First: a network that adds a capability TON lacks (`batch-transfer`, `block-scan`, …)
    // or carries inconsistent data fails here, before any probe. The handle's options too
    // (`maxNetworkFee`); an unknown one is refused.
    const config = tonNetworkConfig(ctx.chain, ctx.network, ctx.options);
    if (!ctx.indexer) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'TON needs an indexer provider (toncenter API v3); set chains.ton.indexer',
      );
    }
    // Probes go on every transport this driver receives, before any traffic. Both expect
    // the global id as parsed from the registry, so they compare values, never spellings.
    const identity = String(config.globalId);
    ctx.transport.setProbes(rpcProbes(identity));
    ctx.indexer.setProbes(indexerProbes(identity));
    const ton = createTonContext({
      api: new TonApi(ctx.transport, ctx.indexer),
      chain: ctx.chain,
      network: ctx.network,
      config,
      log: ctx.log,
      clock: ctx.clock,
    });
    const ext = createTonExt(ton);
    return {
      ordering: 'seqno',
      // Informational: the core gates every capability, `address-history` included, on its
      // own selection (manifest ∪ indexer ∪ network add − remove).
      capabilities: config.capabilities,
      address: ton.codec,
      reader: createTonReader(ton),
      builder: createTonBuilder(ton),
      broadcaster: createTonBroadcaster(ton),
      proofs: createTonProofs(ton),
      sequence: createTonSequence(ton),
      history: createTonHistory(ton),
      ext: { ton: { getSeqno: ext.ton.getSeqno, jettonWallet: ext.ton.jettonWallet } },
      limits: (wallet) => limitsOf(wallet, config.globalId),
      // A fresh SDK client on every call, over this driver's transport.
      createNativeClient: () => makeNative(ctx.transport),
    };
  },
});
