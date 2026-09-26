/**
 * A container on the scripted EVM node, for end-to-end tests. `restart()` builds a new
 * container over the same stores, node and clock, with the same semantics as
 * `createFakeEnv`'s (handoff R20, ruling R71): a plain restart leaves the old container
 * running beside the new one, and `restart({ killPrevious: true })` first kills the old
 * generation through `fenceGeneration`, so every clock sleep, fetch, store and signer call it
 * has in flight or issues later never settles and nothing the "crashed" process started can
 * land. `clock` and `stores` are the shared, unfenced objects: drive time and assert on
 * durable state through them.
 */
import {
  CryptoAio,
  noopLogger,
  type Blockchain,
  type ChainId,
  type LifecycleOptions,
  type Plugin,
  type Signer,
  type Stores,
} from '../../../../src';
import { EVM_CHAINS } from '../../../../src/adapters/evm/chains';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { createMemoryStores } from '../../../../src/core/store/memory';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import type { Library } from './harness';
import { ScriptedEvmNode, type NodeOptions } from './node';
import { KEY, KEY_ADDRESS } from './vectors';

export interface EvmEnvOptions {
  readonly library: Library;
  readonly chain?: string;
  readonly network?: string;
  readonly endpoints?: readonly string[];
  readonly node?: Partial<Omit<NodeOptions, 'clock' | 'chainId'>>;
  /** Wei for the test key's account (default 10^18). */
  readonly fund?: bigint;
  readonly stores?: Partial<Stores>;
  readonly signer?: Signer;
  readonly plugins?: readonly Plugin[];
  readonly lifecycle?: LifecycleOptions;
}

/** A local signer holding the test key that counts its `sign` calls. */
export function countingSigner(): { readonly signer: Signer; calls(): number } {
  const inner = localSigner({ id: 'hot', secp256k1: secret(KEY) });
  let calls = 0;
  const signer: Signer = {
    id: inner.id,
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  };
  return { signer, calls: () => calls };
}

export async function createEvmEnv(options: EvmEnvOptions) {
  const chainId = options.chain ?? 'ethereum';
  const networkId = options.network ?? 'sepolia';
  const chain = [
    ...EVM_CHAINS,
    ...(options.plugins ?? []).flatMap((p) => p.chains ?? []),
  ].find((c) => c.id === chainId);
  const identity = chain?.networks[networkId]?.identity;
  if (identity === undefined)
    throw new Error(`unknown EVM network ${chainId}:${networkId}`);
  const clock = new FakeClock();
  const node = new ScriptedEvmNode({ ...options.node, chainId: BigInt(identity), clock });
  const endpoints = (options.endpoints ?? ['main']).map((name) => ({
    name,
    url: node.endpoint(name),
  }));
  const signer = options.signer ?? countingSigner().signer;
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores };
  node.fund(KEY_ADDRESS, options.fund ?? 10n ** 18n);

  /** One generation (one simulated process): a container over the fenced shared parts. */
  const assemble = (generation: Generation) => {
    const fenced = fenceGeneration(
      { clock, fetch: node.fetch.fetch, stores, signers: { hot: signer } },
      generation,
    );
    const aio = new CryptoAio({
      env: false,
      logger: noopLogger,
      clock: fenced.clock,
      stores: fenced.stores,
      plugins: options.plugins ?? [],
      transport: {
        fetch: fenced.fetch,
        baseDelayMs: 1,
        maxDelayMs: 5,
        timeoutMs: 5_000,
      },
      providers: { node: { endpoints } },
      signers: fenced.signers,
      wallets: { main: { signer: 'hot' } },
      chains: {
        [chainId]: {
          network: networkId,
          library: options.library,
          provider: 'node',
          wallet: 'main',
        },
      },
      lifecycle: {
        pollIntervalMs: 1_000,
        droppedGracePeriodMs: 10_000,
        rebroadcastIntervalMs: 5_000,
        waitTimeoutMs: 600_000,
        leaseMs: 30_000,
        claimLeaseMs: 30_000,
        ...options.lifecycle,
      },
    });
    const bc = aio.blockchain({ chain: chainId as ChainId }) as Blockchain<ChainId>;
    return { aio, bc };
  };

  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  /** Mines one block per fake second until `promise` settles; throws after `maxSteps`. */
  const mineWhile = async <T>(promise: Promise<T>, maxSteps = 600): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let i = 0; i < maxSteps && !done; i++) {
      node.mine();
      await clock.advance(1_000);
    }
    if (!done) throw new Error(`did not settle within ${maxSteps} blocks`);
    return tracked;
  };
  let generation: Generation = { alive: true };
  const first = assemble(generation);
  /**
   * A new container over the same stores, node and clock. `killPrevious` simulates "the old
   * process died": the previous generation is fenced dead before the new one starts.
   */
  const restart = async (restartOptions?: { readonly killPrevious?: boolean }) => {
    if (restartOptions?.killPrevious) generation.alive = false;
    generation = { alive: true };
    return assemble(generation);
  };
  return {
    ...first,
    node,
    clock,
    stores,
    address: KEY_ADDRESS,
    run,
    mineWhile,
    restart,
  };
}
