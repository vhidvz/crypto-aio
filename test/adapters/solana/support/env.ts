/**
 * A container on the scripted Solana node, for end-to-end tests. `restart({ killPrevious })`
 * builds a new container over the same stores, node and clock; with `killPrevious` the old
 * generation's clock, fetch, stores and signer are fenced (`fenceGeneration`, handoff R20),
 * so nothing it started can still act. `aio` and `bc` are the current generation's; `clock`
 * and `stores` are the shared, unfenced objects: drive time and assert on durable state
 * through them. A killed container is never closed (its fenced calls never settle).
 */
import {
  CryptoAio,
  noopLogger,
  type Blockchain,
  type LifecycleOptions,
  type Signer,
  type Stores,
} from '../../../../src';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { createMemoryStores } from '../../../../src/core/store/memory';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import type { Endpoint } from './harness';
import { ScriptedSolanaNode, type NodeOptions } from './node';
import { KEY, KEY_ADDRESS } from './vectors';

export interface SolanaEnvOptions {
  readonly node?: Omit<NodeOptions, 'clock'>;
  readonly endpoints?: readonly Endpoint[];
  /** Lamports for the test key's account (default 10 SOL). */
  readonly fund?: bigint;
  readonly stores?: Partial<Stores>;
  readonly signer?: Signer;
  readonly lifecycle?: LifecycleOptions;
}

/** A local signer holding the test key that counts its `sign` calls. */
export function countingSigner(): { readonly signer: Signer; calls(): number } {
  const inner = localSigner({ id: 'hot', ed25519: secret(KEY) });
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

export async function createSolanaEnv(options: SolanaEnvOptions = {}) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ ...options.node, clock });
  const endpoints = (options.endpoints ?? ['main']).map((entry) => {
    const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
    return { name, url: node.endpoint(name, rest) };
  });
  const signer = options.signer ?? countingSigner().signer;
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores };
  node.fund(KEY_ADDRESS, options.fund ?? 10_000_000_000n);
  node.produce(2);

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
      transport: { fetch: fenced.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 5_000 },
      providers: { node: { endpoints } },
      signers: fenced.signers,
      wallets: { main: { signer: 'hot' } },
      chains: { solana: { network: 'devnet', provider: 'node', wallet: 'main' } },
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
    const bc: Blockchain<'solana'> = aio.blockchain({ chain: 'solana' });
    return { aio, bc };
  };

  let generation: Generation = { alive: true };
  let current = assemble(generation);
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  /**
   * Produces one block per fake 400 ms until `promise` settles; throws after `maxSteps`. The
   * default fits a transfer's way to finality with room to spare (it takes a few blocks), so
   * a stuck wait fails by name, not by Jest's timeout; a longer scenario passes its own.
   */
  const produceWhile = async <T>(promise: Promise<T>, maxSteps = 40): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let i = 0; i < maxSteps && !done; i++) {
      node.produce();
      await clock.advance(400);
    }
    if (!done) throw new Error(`did not settle within ${maxSteps} blocks`);
    return tracked;
  };
  /**
   * A new container over the same stores, node and clock. `killPrevious` simulates "the old
   * process died": the previous generation is fenced dead before the new one starts.
   */
  const restart = (restartOptions: { readonly killPrevious?: boolean } = {}) => {
    if (restartOptions.killPrevious) generation.alive = false;
    generation = { alive: true };
    current = assemble(generation);
    return current;
  };
  return {
    get aio() {
      return current.aio;
    },
    get bc() {
      return current.bc;
    },
    node,
    clock,
    stores,
    address: KEY_ADDRESS,
    run,
    produceWhile,
    restart,
  };
}
