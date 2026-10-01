/**
 * A container on the scripted Avalanche node (Fuji), for the end-to-end suites.
 * `restart({ killPrevious: true })` kills the old generation and builds a new one over the
 * same clock, node, stores and signer (`fenceGeneration`), so no old-generation work can land
 * after the "crash".
 */
import { formatAddress } from '../../../../src/adapters/avalanche/address';
import { CryptoAio } from '../../../../src';
import type { Blockchain } from '../../../../src/core/blockchain/handle';
import type { LifecycleOptions, WalletConfig } from '../../../../src/core/config/types';
import { noopLogger } from '../../../../src/core/events/logger';
import type { Signer } from '../../../../src/core/signing/types';
import { createMemoryStores } from '../../../../src/core/store/memory';
import type { Stores } from '../../../../src/core/store/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import { ScriptedAvalancheNode } from './node';
import { TEST_BYTES, configOf, testSigner, type Vm } from './vectors';

export interface AvalancheEnvOptions {
  readonly vm?: Vm;
  /** Node endpoint names (default one, `a`). */
  readonly endpoints?: readonly string[];
  /** AVAX paid to the wallet, one block each (default 0.1 and 0.2 AVAX). */
  readonly fund?: readonly bigint[];
  readonly lifecycle?: LifecycleOptions;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly wallet?: Partial<WalletConfig>;
  readonly signer?: Signer;
}

export interface AvalancheEnv {
  readonly vm: Vm;
  readonly chain: 'avalanche-x' | 'avalanche-p';
  readonly clock: FakeClock;
  readonly node: ScriptedAvalancheNode;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<'avalanche-x'> | Blockchain<'avalanche-p'>;
  readonly stores: Stores;
  readonly signer: Signer;
  readonly address: string;
  run<T>(promise: Promise<T>, stepMs?: number): Promise<T>;
  /** The canonical address of 20 bytes on this chain. */
  addressOf(bytes: Uint8Array): string;
  restart(options?: { readonly killPrevious?: boolean }): Promise<AvalancheEnv>;
}

interface Shared {
  readonly vm: Vm;
  readonly clock: FakeClock;
  readonly node: ScriptedAvalancheNode;
  readonly rpc: readonly string[];
  readonly indexer: string;
  readonly stores: Stores;
  readonly signer: Signer;
  readonly options: AvalancheEnvOptions;
}

export async function createAvalancheEnv(
  options: AvalancheEnvOptions = {},
): Promise<AvalancheEnv> {
  const vm = options.vm ?? 'avm';
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedAvalancheNode({ clock, vm });
  const rpc = (options.endpoints ?? ['a']).map((name) => node.endpoint(name));
  const indexer = node.indexer('data');
  const stores = createMemoryStores(clock);
  const signer = options.signer ?? testSigner();
  const env = await assemble(
    { vm, clock, node, rpc, indexer, stores, signer, options },
    { alive: true },
  );
  for (const amount of options.fund ?? [100_000_000n, 200_000_000n]) {
    node.fund(TEST_BYTES, amount);
  }
  return env;
}

async function assemble(shared: Shared, generation: Generation): Promise<AvalancheEnv> {
  const { vm, clock, node, rpc, indexer, stores, signer, options } = shared;
  const chain = vm === 'avm' ? 'avalanche-x' : 'avalanche-p';
  const fenced = fenceGeneration(
    { clock, fetch: node.fetch.fetch, stores, signers: { [signer.id]: signer } },
    generation,
  );
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock: fenced.clock,
    stores: fenced.stores,
    signers: fenced.signers,
    transport: { fetch: fenced.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 5_000 },
    providers: {
      node: { endpoints: rpc.map((url, i) => ({ name: `n${i}`, url })) },
      data: { endpoints: [{ name: 'data', url: indexer, kind: 'indexer' }] },
    },
    wallets: { main: { signer: signer.id, ...options.wallet } },
    chains: {
      [chain]: {
        network: 'fuji',
        provider: 'node',
        indexer: 'data',
        wallet: 'main',
        ...(options.options ? { options: options.options } : {}),
      },
    },
    lifecycle: {
      pollIntervalMs: 1_000,
      droppedGracePeriodMs: 10_000,
      rebroadcastIntervalMs: 5_000,
      waitTimeoutMs: 120_000,
      leaseMs: 30_000,
      claimLeaseMs: 30_000,
      ...options.lifecycle,
    },
  });
  const bc = aio.blockchain({ chain }) as AvalancheEnv['bc'];
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  const address = (await run(bc.walletAddress())).canonical;
  const config = configOf(vm);
  return {
    vm,
    chain,
    clock,
    node,
    aio,
    bc,
    stores,
    signer,
    address,
    run,
    addressOf: (bytes) => formatAddress(bytes, config),
    restart: (restartOptions) => {
      if (restartOptions?.killPrevious) generation.alive = false;
      return assemble(shared, { alive: true });
    },
  };
}

/** Mines one block per step while advancing fake time until `promise` settles. */
export async function mineWhile<T>(
  env: AvalancheEnv,
  promise: Promise<T>,
  stepMs = 1_000,
  maxSteps = 200,
): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < maxSteps && !done; i++) {
    env.node.mine();
    await env.clock.advance(stepMs);
  }
  return tracked;
}
