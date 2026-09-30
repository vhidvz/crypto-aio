/**
 * The TON driver (spec §15): one factory for both built-in networks, configured by each
 * network's registry data. The family shape (Plan 2 Task 10, lesson 17 board entry):
 * `tonDriverFactory(makeNative)` lives here and imports no client module; the library's
 * module (`native-client.ts`) supplies the native client and exports the loadable factory.
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
 * F6-R23 M1: the probes read heights and the indexer's global id with `api.ts`'s own
 * parsers, the ones the proofs use, so the two never drift.
 *
 * v2 (R19): identity = config param 19, the network's global id, from a cell that holds
 * exactly one int32 (`global_id#_ global_id:int32 = ConfigParam 19`); height = the
 * liteserver's masterchain head. One call each (Plan 2.5 Task 2: each probe costs a token).
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
 * v3 (R19): identity = the indexed head's `global_id` (an int32); height = the newest
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
 * F6-R15: a TON transfer carries exactly one output (a partly delivered batch has no safe
 * single verdict), whatever the wallet version. The core prefers this answer to its own
 * capability default, so it holds even for a selection that somehow lists `batch-transfer`.
 */
const ONE_OUTPUT: DriverLimits = Object.freeze({ maxOutputs: 1 });

/** The batch limit of a wallet; a malformed TON identity throws its `CONFIG_INVALID` (M18). */
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
    // or carries inconsistent data fails here, before any probe (F6-R15, M3).
    const config = tonNetworkConfig(ctx.chain, ctx.network);
    if (!ctx.indexer) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'TON needs an indexer provider (toncenter API v3); set chains.ton.indexer',
      );
    }
    // M12: probes go on every transport this driver receives, before any traffic. Both
    // expect the global id as parsed from the registry (F3-R12).
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
      // R34: a fresh SDK client on every call, over this driver's transport (D1).
      createNativeClient: () => makeNative(ctx.transport),
    };
  },
});
