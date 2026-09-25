import { secp256k1 } from '@noble/curves/secp256k1';
import type { Blockchain } from '../core/blockchain/handle';
import type {
  AioOptions,
  Hooks,
  LifecycleOptions,
  WalletConfig,
} from '../core/config/types';
import { CryptoAio } from '../core/container/container';
import { noopLogger } from '../core/events/logger';
import { localSigner } from '../core/signing/local';
import type { Signer } from '../core/signing/types';
import { createMemoryStores } from '../core/store/memory';
import type { Stores } from '../core/store/types';
import type { TransportOptions } from '../core/transport/types';
import {
  FakeChain,
  fakeAddress,
  type FakeChainOptions,
  type FakeEndpointOptions,
  type FakeOrdering,
} from './fake-chain';
import { FakeClock, drive } from './fake-clock';
import { fakePlugin } from './fake-plugin';
import { fenceGeneration, type Generation } from './generation';

export type FakeChainId = 'fakechain' | 'fakeexpiry' | 'fakeseqno';

export interface FakeEnvOptions {
  readonly ordering?: FakeOrdering;
  readonly endpoints?: readonly (
    string | ({ readonly name: string } & FakeEndpointOptions)
  )[];
  /** Funds the wallet with this many base units (default 1_000_000). Use 0n for none. */
  readonly fund?: bigint;
  readonly chain?: Omit<FakeChainOptions, 'ordering' | 'clock'>;
  readonly wallets?: Readonly<Record<string, WalletConfig>>;
  readonly signer?: Signer;
  readonly stores?: Partial<Stores>;
  readonly transport?: Omit<TransportOptions, 'fetch'>;
  readonly lifecycle?: LifecycleOptions;
  readonly hooks?: Hooks;
  /** Extra container options merged last. Never `clock`, `stores` or `transport` — those are
   * always the generation-fenced values (N3), so this type excludes them; passing any of them
   * would either fail to type-check or (if forced through) be silently overridden. Its
   * `signers` are merged by name over the default signer, and every entry is fenced (N-B). */
  readonly aio?: Omit<AioOptions, 'clock' | 'stores' | 'transport'>;
}

export interface FakeEnv {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<FakeChainId>;
  /**
   * N-D: the raw, unfenced `Signer` instance — the same object across every `restart()`
   * (stateless, never rebuilt). The container itself holds a fenced PROXY of it (see
   * `generationSigner`/N-B), not this object, so an identity assertion against the
   * container's copy (e.g. `containerOf(aio).effective().signers[id]`) must compare `.id`,
   * never `===` against this field.
   */
  readonly signer: Signer;
  readonly stores: Stores;
  readonly address: string;
  readonly chainId: FakeChainId;
  /** Drives a promise to completion on fake time (100 ms steps by default). */
  run<T>(promise: Promise<T>, stepMs?: number): Promise<T>;
  /** A fresh, unrelated fake-chain address. */
  stranger(): string;
  /**
   * Simulates a process restart: a new container (new pool, bus and owner id) attached to
   * the same durable state (stores, FakeChain, the one simulated FakeClock). By default the
   * previous generation's env keeps working — later tasks run two generations concurrently
   * this way. `{ killPrevious: true }` simulates "the old process died": every clock sleep,
   * fetch and store call already in flight or issued later on the OLD generation's handles
   * and stores never settles (neither resolves nor rejects), so it can make no further
   * progress and no old continuation can write to shared state.
   */
  restart(options?: { readonly killPrevious?: boolean }): Promise<FakeEnv>;
}

interface Shared {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly chainId: FakeChainId;
  readonly endpoints: readonly { readonly name: string; readonly url: string }[];
  readonly signer: Signer;
  readonly stores: Stores;
  readonly options: FakeEnvOptions;
}

export async function createFakeEnv(options: FakeEnvOptions = {}): Promise<FakeEnv> {
  const clock = new FakeClock();
  const ordering = options.ordering ?? 'nonce';
  const chain = new FakeChain({ ...options.chain, ordering, clock });
  const chainId: FakeChainId =
    ordering === 'nonce'
      ? 'fakechain'
      : ordering === 'expiry'
        ? 'fakeexpiry'
        : 'fakeseqno';
  const endpoints = (options.endpoints ?? ['main']).map((entry) => {
    const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
    return { name, url: chain.endpoint(name, rest) };
  });
  const signer =
    options.signer ?? localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  const overrides = Object.fromEntries(
    Object.entries(options.stores ?? {}).filter(([, store]) => store !== undefined),
  ) as Partial<Stores>;
  const stores: Stores = { ...createMemoryStores(clock), ...overrides };
  const env = await assemble(
    { clock, chain, chainId, endpoints, signer, stores, options },
    { alive: true },
  );
  const fund = options.fund ?? 1_000_000n;
  if (fund > 0n) chain.fund(env.address, fund);
  return env;
}

async function assemble(shared: Shared, generation: Generation): Promise<FakeEnv> {
  const { clock, chain, chainId, endpoints, signer, stores, options } = shared;
  // A local signer is stateless (holds no per-process state), so it is shared across
  // generations rather than rebuilt on every restart() — only its calls are fenced (N2). N-B:
  // every entry of the FINAL merged map (the default signer plus `options.aio.signers`, the
  // latter winning by name) is fenced, and it's applied after `...options.aio` below so an
  // `aio.signers` map can never bypass the fence.
  const fenced = fenceGeneration(
    {
      clock,
      fetch: chain.fetch,
      stores,
      signers: { [signer.id]: signer, ...options.aio?.signers },
    },
    generation,
  );
  const genStores = fenced.stores;
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    plugins: [fakePlugin()],
    providers: { fake: { endpoints } },
    wallets: { main: { signer: signer.id }, ...options.wallets },
    chains: { [chainId]: { provider: 'fake', wallet: 'main' } },
    lifecycle: {
      pollIntervalMs: 1_000,
      droppedGracePeriodMs: 10_000,
      rebroadcastIntervalMs: 5_000,
      waitTimeoutMs: 120_000,
      leaseMs: 30_000,
      claimLeaseMs: 30_000,
      ...options.lifecycle,
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...options.aio,
    // N3: applied AFTER `options.aio`, so a generation's fencing can never be shadowed by it
    // (its type already excludes clock/stores/transport — see `FakeEnvOptions.aio`; `signers`
    // is the fenced merge above, N-B). `env.stores` below reads the same `genStores` object
    // handed to the container here, so they're guaranteed to be the same fenced instances.
    signers: fenced.signers,
    clock: fenced.clock,
    stores: genStores,
    transport: {
      fetch: fenced.fetch,
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 5_000,
      ...options.transport,
    },
  });
  const bc = aio.blockchain({ chain: chainId });
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  const address = (await run(bc.walletAddress())).canonical;
  const stranger = () =>
    fakeAddress(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));
  const restart = (restartOptions?: {
    readonly killPrevious?: boolean;
  }): Promise<FakeEnv> => {
    if (restartOptions?.killPrevious) generation.alive = false;
    return assemble(shared, { alive: true });
  };
  return {
    clock,
    chain,
    aio,
    bc,
    signer,
    stores: genStores,
    address,
    chainId,
    run,
    stranger,
    restart,
  };
}
