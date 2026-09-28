/**
 * A container on the scripted Esplora node (regtest), for the UTXO end-to-end suites.
 * `restart({ killPrevious: true })` kills the old generation and builds a new one over the
 * same raw clock, node, stores and signer (handoff R20, ruling A5: `fenceGeneration` from
 * `src/testing/generation.ts`, as Plan 2 Task 11 uses it), so no old-generation work can
 * land after the "crash". The killed container is never closed: its fenced calls never
 * settle. `env.stores` are the raw stores, readable after a kill.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { walletAddress } from '../../../../src/adapters/utxo/address';
import type { UtxoAddressType } from '../../../../src/adapters/utxo/types';
import type { Blockchain } from '../../../../src/core/blockchain/handle';
import type { LifecycleOptions, WalletConfig } from '../../../../src/core/config/types';
import { CryptoAio } from '../../../../src';
import { noopLogger } from '../../../../src/core/events/logger';
import { callbackSigner } from '../../../../src/core/signing/callback';
import type { Signer } from '../../../../src/core/signing/types';
import { createMemoryStores } from '../../../../src/core/store/memory';
import type { Stores } from '../../../../src/core/store/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import { ScriptedEsploraNode, type ScriptedEsploraNodeOptions } from './node';
import { REGTEST, testSigner } from './vectors';

export interface UtxoEnvOptions {
  readonly addressType?: UtxoAddressType;
  /** Endpoint names (default one, `a`); each may lag. Every endpoint serves rpc and indexer. */
  readonly endpoints?: readonly (
    string | { readonly name: string; readonly lag?: number }
  )[];
  readonly node?: Omit<Partial<ScriptedEsploraNodeOptions>, 'clock'>;
  /** Confirmed outputs paid to the wallet, one block each (default 100,000 and 200,000 sat). */
  readonly fund?: readonly bigint[];
  readonly lifecycle?: LifecycleOptions;
  /** `chains.bitcoin.options` (the driver options). */
  readonly options?: Readonly<Record<string, unknown>>;
  readonly wallet?: Partial<WalletConfig>;
  readonly stores?: Partial<Stores>;
  readonly signer?: Signer;
}

export interface UtxoEnv {
  readonly clock: FakeClock;
  readonly node: ScriptedEsploraNode;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<'bitcoin'>;
  /** The raw stores (no generation): readable after `restart({ killPrevious: true })`. */
  readonly stores: Stores;
  readonly signer: Signer;
  readonly address: string;
  run<T>(promise: Promise<T>, stepMs?: number): Promise<T>;
  /** A fresh p2wpkh address nobody here controls. */
  stranger(): string;
  restart(options?: { readonly killPrevious?: boolean }): Promise<UtxoEnv>;
}

interface Shared {
  readonly clock: FakeClock;
  readonly node: ScriptedEsploraNode;
  readonly urls: readonly string[];
  readonly stores: Stores;
  readonly signer: Signer;
  readonly options: UtxoEnvOptions;
}

let strangers = 0;

export async function createUtxoEnv(options: UtxoEnvOptions = {}): Promise<UtxoEnv> {
  const clock = new FakeClock();
  const node = new ScriptedEsploraNode({ clock, ...options.node });
  const urls = (options.endpoints ?? ['a']).map((entry) =>
    typeof entry === 'string' ? node.endpoint(entry) : node.endpoint(entry.name, entry),
  );
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores };
  const signer = options.signer ?? testSigner();
  const env = await assemble(
    { clock, node, urls, stores, signer, options },
    { alive: true },
  );
  for (const value of options.fund ?? [100_000n, 200_000n]) node.fund(env.address, value);
  return env;
}

async function assemble(shared: Shared, generation: Generation): Promise<UtxoEnv> {
  const { clock, node, urls, stores, signer, options } = shared;
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
    providers: { esplora: { endpoints: urls.map((url, i) => ({ name: `e${i}`, url })) } },
    wallets: {
      main: {
        signer: signer.id,
        ...(options.addressType ? { utxo: { addressType: options.addressType } } : {}),
        ...options.wallet,
      },
    },
    chains: {
      bitcoin: {
        network: 'regtest',
        provider: 'esplora',
        indexer: 'esplora',
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
  const bc = aio.blockchain({ chain: 'bitcoin' });
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  const address = (await run(bc.walletAddress())).canonical;
  return {
    clock,
    node,
    aio,
    bc,
    stores,
    signer,
    address,
    run,
    stranger: () => {
      const key = secp256k1.getPublicKey(numberKey(++strangers), true);
      return walletAddress(key, 'p2wpkh', REGTEST).address;
    },
    restart: (restartOptions) => {
      if (restartOptions?.killPrevious) generation.alive = false;
      return assemble(shared, { alive: true });
    },
  };
}

/** A deterministic private key for the n-th stranger. */
function numberKey(n: number): Uint8Array {
  const key = new Uint8Array(32);
  key[0] = 0x55;
  key[31] = n & 0xff;
  key[30] = (n >> 8) & 0xff;
  return key;
}

/** The test key's signer, counting how many times it was asked to sign. */
export function countingSigner(id = 'hot'): { signer: Signer; calls: () => number } {
  const inner = testSigner(id);
  let calls = 0;
  const signer = callbackSigner({
    id,
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: async (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  });
  return { signer, calls: () => calls };
}

/** Mines one block per step while advancing fake time until `promise` settles. */
export async function mineWhile<T>(
  env: UtxoEnv,
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
