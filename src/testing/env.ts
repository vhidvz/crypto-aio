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
  /** Extra container options merged last. */
  readonly aio?: AioOptions;
}

export interface FakeEnv {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<FakeChainId>;
  readonly signer: Signer;
  readonly stores: Stores;
  readonly address: string;
  readonly chainId: FakeChainId;
  /** Drives a promise to completion on fake time (100 ms steps by default). */
  run<T>(promise: Promise<T>, stepMs?: number): Promise<T>;
  /** A fresh, unrelated fake-chain address. */
  stranger(): string;
  /** Simulates a process restart: new container, same stores, chain, clock and signer. */
  restart(): Promise<FakeEnv>;
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
  const env = await assemble({
    clock,
    chain,
    chainId,
    endpoints,
    signer,
    stores,
    options,
  });
  const fund = options.fund ?? 1_000_000n;
  if (fund > 0n) chain.fund(env.address, fund);
  return env;
}

async function assemble(shared: Shared): Promise<FakeEnv> {
  const { clock, chain, chainId, endpoints, signer, stores, options } = shared;
  const aio = new CryptoAio({
    env: false,
    clock,
    logger: noopLogger,
    plugins: [fakePlugin()],
    stores,
    transport: {
      fetch: chain.fetch,
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 5_000,
      ...options.transport,
    },
    providers: { fake: { endpoints } },
    signers: { [signer.id]: signer },
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
  });
  const bc = aio.blockchain({ chain: chainId });
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  const address = (await run(bc.walletAddress())).canonical;
  const stranger = () =>
    fakeAddress(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));
  return {
    clock,
    chain,
    aio,
    bc,
    signer,
    stores,
    address,
    chainId,
    run,
    stranger,
    restart: () => assemble(shared),
  };
}
