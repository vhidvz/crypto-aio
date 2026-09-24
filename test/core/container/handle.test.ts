import { HDKey } from '@scure/bip32';
import { internalsOf } from '../../../src/core/blockchain/internal';
import { Blockchain } from '../../../src/core/blockchain/handle';
import { statusFromObservation } from '../../../src/core/blockchain/mapping';
import { CryptoAio } from '../../../src/core/container/container';
import {
  configure,
  defaultContainer,
  resetDefaultContainer,
} from '../../../src/core/container/default';
import { containerOf } from '../../../src/core/container/internals';
import type { AdapterManifest } from '../../../src/core/driver/types';
import { noopLogger } from '../../../src/core/events/logger';
import { localSigner } from '../../../src/core/signing/local';
import { createMemoryStores } from '../../../src/core/store/memory';
import { FakeClock } from '../../../src/testing/fake-clock';
import { fromHex } from '../../../src/core/util/bytes';
import { fakeAddress } from '../../../src/testing/fake-chain';
import { createFakeEnv } from '../../../src/testing/env';
import { fakeDriverFactory } from '../../../src/testing/fake-driver';
import { fakePlugin } from '../../../src/testing/fake-plugin';
import { thrown } from '../../helpers';

afterEach(() => resetDefaultContainer());

describe('Blockchain handle', () => {
  it('exposes resolved, redacted metadata and is frozen', async () => {
    const env = await createFakeEnv();
    expect(env.bc.chain).toBe('fakechain');
    expect(env.bc.network).toBe('local');
    expect(env.bc.library).toBe('fake-sdk');
    expect(env.bc.supports('replace-fee')).toBe(true);
    expect(env.bc.supports('tokens')).toBe(false);
    expect(env.bc.config).toMatchObject({
      chain: 'fakechain',
      wallet: 'main',
      signer: 'hot',
      confirmations: 2,
    });
    expect(Object.isFrozen(env.bc)).toBe(true);
  });

  it('capabilities() returns a copy; mutating it cannot change supports()', async () => {
    const env = await createFakeEnv();
    const caps = env.bc.capabilities as unknown as Set<string>;
    expect(caps.has('tokens')).toBe(false);
    caps.add('tokens');
    expect(env.bc.supports('tokens')).toBe(false);
    expect(env.bc.capabilities.has('tokens')).toBe(false);
  });

  it('returns a new handle from with() and leaves the original unchanged', async () => {
    const env = await createFakeEnv();
    const five = env.bc.with({ confirmations: 5 });
    expect(five).not.toBe(env.bc);
    expect(five.config.confirmations).toBe(5);
    expect(env.bc.config.confirmations).toBe(2);
  });

  it('shares drivers within a container but never across containers', async () => {
    const env = await createFakeEnv();
    const a = await env.run(internalsOf(env.bc).pooled());
    const b = await env.run(
      internalsOf(env.aio.blockchain({ chain: 'fakechain' })).pooled(),
    );
    expect(a.driver).toBe(b.driver);
    const other = await createFakeEnv();
    const c = await other.run(internalsOf(other.bc).pooled());
    expect(c.driver).not.toBe(a.driver);
  });

  it('shares one pool entry across wallets/signers without leaking either through it', async () => {
    const env = await createFakeEnv();
    const otherSigner = localSigner.generate({
      curves: ['secp256k1'],
      id: 'other',
    }).signer;
    const scoped = env.aio.scope({
      signers: { other: otherSigner },
      wallets: { second: { signer: 'other' } },
    });
    const secondBc = scoped.blockchain({ chain: 'fakechain', wallet: 'second' });
    const a = await env.run(internalsOf(env.bc).pooled());
    const b = await env.run(internalsOf(secondBc).pooled());
    expect(a.driver).toBe(b.driver);
    expect((a as unknown as { selection?: unknown }).selection).toBeUndefined();
    expect((b as unknown as { selection?: unknown }).selection).toBeUndefined();
  });

  it('reads balances, heights, blocks and transactions', async () => {
    const env = await createFakeEnv({ fund: 150_000_000n });
    env.chain.mine(2);
    const balance = await env.run(env.bc.getBalance(env.address));
    expect(balance.amount.format()).toBe('1.5 FAKE');
    expect(balance.address.canonical).toBe(env.address);
    expect(await env.run(env.bc.getBlockHeight())).toBe(2n);
    expect((await env.run(env.bc.getBlock(0n)))?.hash).toBe(env.chain.block(0n)?.hash);
    expect(await env.run(env.bc.getTransaction('ab'.repeat(32)))).toBeNull();
    expect(await env.run(env.bc.getTransactionStatus('ab'.repeat(32)))).toMatchObject({
      state: 'unknown',
      evidence: 'observed',
    });
    const [native] = await env.run(env.bc.getBalances(env.address, ['FAKE']));
    expect(native?.amount.base).toBe(150_000_000n);
  });

  it('resolves assets by alias and id and rejects foreign or unsupported assets', async () => {
    const env = await createFakeEnv();
    expect((await env.run(env.bc.resolveAsset('fake'))).id).toBe(
      'fakechain:local/native',
    );
    expect((await env.run(env.bc.resolveAsset('fakechain:local/native'))).ref).toBe(
      'native',
    );
    await expect(
      env.run(env.bc.resolveAsset('fakeexpiry:local/native')),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    await expect(
      env.run(env.bc.resolveAsset({ standard: 'erc20', contract: '0x1' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('validates and normalizes addresses', async () => {
    const env = await createFakeEnv();
    expect(await env.run(env.bc.validateAddress('nope'))).toBe(false);
    const upper = env.address.toUpperCase().replace('FK1', 'fk1');
    expect((await env.run(env.bc.normalizeAddress(upper))).canonical).toBe(env.address);
    await expect(env.run(env.bc.normalizeAddress('nope'))).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    });
    expect((await env.run(env.bc.walletAddress())).canonical).toBe(env.address);
  });

  it('derives deposit addresses from an xpub without private keys', async () => {
    const account = HDKey.fromMasterSeed(
      fromHex('000102030405060708090a0b0c0d0e0f'),
    ).derive("m/44'/0'/0'");
    const env = await createFakeEnv({
      wallets: { deposits: { xpub: account.publicExtendedKey } },
    });
    const derived = await env.run(env.bc.deriveAddress('deposits', 3));
    expect(derived.canonical).toBe(
      fakeAddress(account.derive('m/0/3').publicKey as Uint8Array),
    );
    await expect(env.run(env.bc.deriveAddress('main', 0))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(env.run(env.bc.deriveAddress('deposits', -1))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });

  it('reports network status with semantic endpoint health', async () => {
    const env = await createFakeEnv({ endpoints: ['a', { name: 'b', lag: 4 }] });
    env.chain.mine(10);
    const status = await env.run(env.bc.getNetworkStatus());
    expect(status.height).toBe(10n);
    expect(status.finalizedHeight).toBe(7n);
    expect(status.endpoints).toEqual([
      expect.objectContaining({ id: 'fake/a', state: 'healthy' }),
      expect.objectContaining({ id: 'fake/b', state: 'lagging', lag: 4n }),
    ]);
  });

  it('estimates fees as Amounts in the fee asset', async () => {
    const env = await createFakeEnv();
    const fee = await env.run(env.bc.estimateFee({ to: env.stranger(), amount: '1' }));
    expect(fee.charges.map((c) => c.amount.format())).toEqual(['0.00000002 FAKE']);
    await expect(
      env.run(env.bc.estimateFee({ to: env.stranger(), amount: 1 as unknown as bigint })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      env.run(env.bc.estimateFee({ to: env.stranger(), amount: '0' })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('loads adapters lazily and surfaces DEPENDENCY_MISSING', async () => {
    const broken: AdapterManifest = {
      family: 'fake',
      library: 'broken-sdk',
      chains: ['fakechain'],
      capabilities: [],
      peerDependencies: [{ name: 'broken-sdk', range: '^2.0.0' }],
      load: async () => {
        throw Object.assign(new Error("Cannot find module 'broken-sdk'"), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    };
    const env = await createFakeEnv();
    env.aio.use({ name: 'broken', adapters: [broken] });
    const bc = env.aio.blockchain({
      chain: 'fakechain',
      library: 'broken-sdk' as 'fake-sdk',
    });
    await expect(env.run(bc.ready())).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
      message: expect.stringMatching(/npm i broken-sdk@\^2\.0\.0/),
    });
  });

  it('exposes typed family extensions through a lazy proxy', async () => {
    const env = await createFakeEnv();
    env.chain.mine(3);
    expect(await env.run(env.bc.ext.fake.head())).toBe(3n);
    const loose = env.bc.ext as unknown as { fake: { nope(): Promise<unknown> } };
    await expect(env.run(loose.fake.nope())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect((env.bc.ext as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

describe('statusFromObservation', () => {
  it('gives 1 confirmation when head equals the block height', () => {
    const status = statusFromObservation({ seen: 'block', blockHeight: 5n }, 5n, 0n);
    expect(status).toMatchObject({
      state: 'included',
      evidence: 'observed',
      confirmations: 1,
      finality: 'probabilistic',
    });
  });

  it('reports a finalized block as included, not final, with observed evidence', () => {
    const status = statusFromObservation({ seen: 'block', blockHeight: 5n }, 8n, 5n);
    expect(status.state).toBe('included');
    expect(status.state).not.toBe('final');
    expect(status.evidence).toBe('observed');
    expect(status.finality).toBe('final');
  });

  it('reports a failed transaction as failed regardless of finality', () => {
    const status = statusFromObservation(
      { seen: 'block', blockHeight: 5n, success: false },
      5n,
      5n,
    );
    expect(status.state).toBe('failed');
  });

  it('gives 0 confirmations for a lagging (inconsistent) head', () => {
    const status = statusFromObservation({ seen: 'block', blockHeight: 10n }, 5n, 0n);
    expect(status.confirmations).toBe(0);
  });
});

describe('DriverPool', () => {
  it('closes and rejects further use with StateError; a handle pooled beforehand is unaffected', async () => {
    const env = await createFakeEnv();
    await env.run(internalsOf(env.bc).pooled());
    await env.aio.close();
    const fresh = env.aio.blockchain({ chain: 'fakechain' });
    await expect(env.run(internalsOf(fresh).pooled())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(await env.run(env.bc.getBlockHeight())).toBe(0n);
  });

  it('shares one in-flight creation between concurrent get() calls on the same pool key', async () => {
    const env = await createFakeEnv();
    let loads = 0;
    const counted: AdapterManifest = {
      family: 'fake',
      library: 'counted-sdk',
      chains: ['fakechain'],
      capabilities: [],
      peerDependencies: [],
      load: async () => {
        loads += 1;
        return fakeDriverFactory;
      },
    };
    env.aio.use({ name: 'counted', adapters: [counted] });
    const bcA = env.aio.blockchain({
      chain: 'fakechain',
      library: 'counted-sdk' as 'fake-sdk',
    });
    const bcB = env.aio.blockchain({
      chain: 'fakechain',
      library: 'counted-sdk' as 'fake-sdk',
    });
    const [a, b] = await env.run(
      Promise.all([internalsOf(bcA).pooled(), internalsOf(bcB).pooled()]),
    );
    expect(a.driver).toBe(b.driver);
    expect(loads).toBe(1);
  });

  it('retries pool creation after a failure instead of caching the rejection', async () => {
    const env = await createFakeEnv();
    let attempts = 0;
    const flaky: AdapterManifest = {
      family: 'fake',
      library: 'flaky-sdk',
      chains: ['fakechain'],
      capabilities: [],
      peerDependencies: [{ name: 'flaky-sdk', range: '^1.0.0' }],
      load: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Cannot find module 'flaky-sdk'"), {
            code: 'MODULE_NOT_FOUND',
          });
        }
        return fakeDriverFactory;
      },
    };
    env.aio.use({ name: 'flaky', adapters: [flaky] });
    const bc = env.aio.blockchain({
      chain: 'fakechain',
      library: 'flaky-sdk' as 'fake-sdk',
    });
    await expect(env.run(bc.ready())).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
    await expect(env.run(bc.ready())).resolves.toBe(bc);
    expect(attempts).toBe(2);
  });

  it('reports driver limits', async () => {
    const env = await createFakeEnv();
    expect(await env.run(env.bc.limits())).toEqual({ maxOutputs: 1 });
  });
});

describe('ready()', () => {
  it('surfaces a ConfigError from an invalid wallet', async () => {
    const env = await createFakeEnv();
    const scoped = env.aio.scope({
      wallets: { bad: { signer: 'hot', address: env.stranger() } },
    });
    const bc = scoped.blockchain({ chain: 'fakechain', wallet: 'bad' });
    await expect(env.run(bc.ready())).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('throws PROVIDER_UNAVAILABLE when every endpoint is down', async () => {
    const env = await createFakeEnv();
    env.chain.configureEndpoint('main', { down: true });
    await expect(env.run(env.bc.ready())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('throws non-retryable PROVIDER_MISCONFIGURED when every endpoint has the wrong identity', async () => {
    const env = await createFakeEnv();
    env.chain.configureEndpoint('main', { identity: 'some-other-network' });
    await expect(env.run(env.bc.ready())).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
      retryable: false,
    });
  });

  it('resolves once healthy and returns the handle itself', async () => {
    const env = await createFakeEnv();
    await expect(env.run(env.bc.ready())).resolves.toBe(env.bc);
  });
});

describe('containers', () => {
  it('Blockchain.create uses the default container; configure() only affects new handles', async () => {
    const env = await createFakeEnv();
    configure({
      env: false,
      logger: noopLogger,
      plugins: [fakePlugin()],
      transport: { fetch: env.chain.fetch },
      providers: { fake: { endpoints: [{ url: env.chain.endpoint('default') }] } },
      chains: { fakechain: { provider: 'fake' } },
    });
    const before = Blockchain.create({ chain: 'fakechain' });
    configure({ chains: { fakechain: { confirmations: 7 } } });
    const after = Blockchain.create({ chain: 'fakechain' });
    expect(before.config.confirmations).toBe(2);
    expect(after.config.confirmations).toBe(7);
    expect(await env.run(after.getBlockHeight())).toBe(0n);
  });

  it('isolates tenant containers from each other', async () => {
    const env = await createFakeEnv();
    const tenant = new CryptoAio({
      env: false,
      logger: noopLogger,
      plugins: [fakePlugin()],
    });
    expect(
      thrown(() =>
        tenant.blockchain({
          chain: 'fakechain',
          provider: { endpoints: [{ url: env.chain.endpoint('t') }] },
          wallet: 'main',
        }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/unknown wallet 'main'/),
    });
  });

  it('lets scopes override without mutating the parent and keeps plugins root-only', async () => {
    const env = await createFakeEnv();
    const scoped = env.aio.scope({ chains: { fakechain: { confirmations: 9 } } });
    expect(scoped.namespace).toBe(env.aio.namespace);
    expect(scoped.blockchain({ chain: 'fakechain' }).config.confirmations).toBe(9);
    expect(env.aio.blockchain({ chain: 'fakechain' }).config.confirmations).toBe(2);
    expect(thrown(() => scoped.use({ name: 'x' }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(thrown(() => new CryptoAio({ namespace: 'bad namespace!' }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('configure() accumulates stores key by key across calls, keeping earlier ones', async () => {
    const env = await createFakeEnv();
    const storesA = createMemoryStores(new FakeClock());
    const storesB = createMemoryStores(new FakeClock());
    configure({
      env: false,
      logger: noopLogger,
      plugins: [fakePlugin()],
      clock: env.clock,
      transport: { fetch: env.chain.fetch },
      providers: { fake: { endpoints: [{ url: env.chain.endpoint('i2') }] } },
      chains: { fakechain: { provider: 'fake' } },
      stores: { operations: storesA.operations },
    });
    configure({ stores: { cursors: storesB.cursors } });
    const runtime = containerOf(defaultContainer()).runtime;
    expect(runtime.stores.operations).toBe(storesA.operations);
    expect(runtime.stores.cursors).toBe(storesB.cursors);
  });
});
