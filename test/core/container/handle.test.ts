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
import type { AioOptions } from '../../../src/core/config/types';
import type { AdapterManifest } from '../../../src/core/driver/types';
import { secret } from '../../../src/core/secret/secret';
import { normalizeIntent } from '../../../src/core/lifecycle/intent';
import { noopLogger } from '../../../src/core/events/logger';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import { createMemoryStores } from '../../../src/core/store/memory';
import type { Transport } from '../../../src/core/transport/types';
import { FakeClock } from '../../../src/testing/fake-clock';
import { fromHex } from '../../../src/core/util/bytes';
import { fakeAddress } from '../../../src/testing/fake-chain';
import { createFakeEnv, type FakeChainId, type FakeEnv } from '../../../src/testing/env';
import { fakeDriverFactory } from '../../../src/testing/fake-driver';
import { fakeManifest, fakePlugin } from '../../../src/testing/fake-plugin';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
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

  it("gates token resolution on the resolved selection's capabilities, not the driver's own", async () => {
    const env = await createFakeEnv();
    const internals = internalsOf(env.bc);
    const pooled = await env.run(internals.pooled());
    const assets = containerOf(env.aio).runtime.assets;
    const driverWithTokens = {
      ...pooled.driver,
      capabilities: new Set([...pooled.driver.capabilities, 'tokens']),
      reader: {
        ...pooled.driver.reader,
        getTokenMetadata: async () => ({ symbol: 'TKN', decimals: 6 }),
      },
    };
    await expect(
      assets.resolve(internals.selection, driverWithTokens, {
        standard: 'erc20',
        contract: '0xabc',
      }),
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

  it('walletAddress(name) resolves a different configured wallet without changing the handle', async () => {
    const env = await createFakeEnv();
    const otherSigner = localSigner.generate({
      curves: ['secp256k1'],
      id: 'other',
    }).signer;
    const scoped = env.aio.scope({
      signers: { other: otherSigner },
      wallets: { spare: { signer: 'other' } },
    });
    const bc = scoped.blockchain({ chain: 'fakechain', wallet: 'main' });
    const mainAddress = await env.run(bc.walletAddress());
    const spareAddress = await env.run(bc.walletAddress('spare'));
    expect(mainAddress.canonical).toBe(env.address);
    expect(spareAddress.canonical).not.toBe(mainAddress.canonical);
    expect(bc.config.wallet).toBe('main');
    await expect(env.run(bc.walletAddress('nope'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('walletAddress(name) applies the same per-chain checks resolveSelection would', async () => {
    const env = await createFakeEnv();
    // A wallet restricted to a DIFFERENT chain must fail the same `wallet.chains`
    // enablement check a directly-selected wallet would get, not silently resolve.
    const scoped = env.aio.scope({
      wallets: { restricted: { signer: 'hot', chains: ['fakeexpiry'] } },
    });
    const bc = scoped.blockchain({ chain: 'fakechain', wallet: 'main' });
    await expect(env.run(bc.walletAddress('restricted'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/not enabled for chain 'fakechain'/),
    });
    // An own-property lookup — a wallet literally named 'constructor' is unknown, not
    // `Object.prototype.constructor`.
    await expect(env.run(bc.walletAddress('constructor'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
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

  it('checks the extended key network class on UTXO chains only', async () => {
    const seed = fromHex('000102030405060708090a0b0c0d0e0f');
    const tpubVersions = { private: 0x04358394, public: 0x043587cf };
    const xpub = HDKey.fromMasterSeed(seed).derive("m/44'/0'/0'").publicExtendedKey;
    const tpub = HDKey.fromMasterSeed(seed, tpubVersions).derive(
      "m/44'/1'/0'",
    ).publicExtendedKey;
    const env = await createFakeEnv({ wallets: { x: { xpub }, t: { xpub: tpub } } });
    // The fake chain is an account-model test network: its xpub keeps deriving, as EVM and
    // Tron wallets export `xpub` on every network.
    await expect(env.run(env.bc.deriveAddress('x', 0))).resolves.toBeDefined();
    // A UTXO-model chain, with a test network and a mainnet, served by the same fake driver.
    const fakechain = (fakePlugin().chains ?? [])[0] as ChainInfo;
    const local = fakechain.networks['local'] as NetworkInfo;
    env.aio.use({
      name: 'fake-utxo',
      chains: [
        {
          ...fakechain,
          id: 'fakeutxo',
          family: 'fakeutxo',
          model: 'utxo',
          networks: { local, main: { ...local, id: 'main', testnet: false } },
        },
      ],
      adapters: [{ ...fakeManifest, family: 'fakeutxo', chains: ['fakeutxo'] }],
    });
    const utxo = (network: string) =>
      env.aio.blockchain({
        chain: 'fakeutxo' as FakeChainId,
        network: network as never,
        provider: 'fake',
        wallet: 'main',
      });
    const error = await env
      .run(utxo('local').deriveAddress('x', 0))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(JSON.stringify(error)).not.toContain(xpub.slice(4, 20));
    expect((error as Error).cause).toBeUndefined();
    await expect(env.run(utxo('local').deriveAddress('t', 0))).resolves.toBeDefined();
    // A test key on the UTXO mainnet is refused; a mainnet key there derives.
    await expect(env.run(utxo('main').deriveAddress('t', 0))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(env.run(utxo('main').deriveAddress('x', 0))).resolves.toBeDefined();
    // A UTXO chain whose wallets export `xpub` everywhere opts out (Avalanche X/P).
    env.aio.use({
      name: 'fake-unclassed',
      chains: [
        {
          ...fakechain,
          id: 'fakeunclassed',
          family: 'fakeunclassed',
          model: 'utxo',
          xpubNetworkClass: false,
        },
      ],
      adapters: [{ ...fakeManifest, family: 'fakeunclassed', chains: ['fakeunclassed'] }],
    });
    const unclassed = env.aio.blockchain({
      chain: 'fakeunclassed' as FakeChainId,
      network: 'local' as never,
      provider: 'fake',
      wallet: 'main',
    });
    await expect(env.run(unclassed.deriveAddress('x', 0))).resolves.toBeDefined();
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

  it('never reports a finalized height above the head it reports', async () => {
    const env = await createFakeEnv();
    env.chain.mine(10);
    const { driver } = await env.run(internalsOf(env.bc).pooled());
    // The heights are two reads: a block can land between them, or they can reach
    // endpoints at different heights. Where the latest block is final (Avalanche), the
    // finalized height then passes the head.
    driver.reader.getFinalizedHeight = async () => 11n;
    const status = await env.run(env.bc.getNetworkStatus());
    expect([status.height, status.finalizedHeight]).toEqual([10n, 10n]);
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

  it('normalizeIntent validates fee and memo shapes before reaching the driver', async () => {
    const env = await createFakeEnv();
    const internals = internalsOf(env.bc);
    const pooled = await env.run(internals.pooled());
    const from = await env.run(env.bc.walletAddress());
    const ctx = {
      selection: internals.selection,
      driver: pooled.driver,
      assets: containerOf(env.aio).runtime.assets,
    };
    await expect(
      normalizeIntent(ctx, { to: env.stranger(), amount: '1', fee: { fee: 5 } }, from),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      normalizeIntent(
        ctx,
        { to: env.stranger(), amount: '1', memo: 42 as unknown as string },
        from,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      normalizeIntent(
        ctx,
        { to: env.stranger(), amount: '1', fee: { fee: 1_000n }, memo: 'ok' },
        from,
      ),
    ).resolves.toMatchObject({ fee: { fee: 1_000n }, memo: 'ok' });
    // An omitted optional field (`undefined`) inside an override is not "non-plain data",
    // and a top-level `fee: undefined` simply means "no fee override".
    await expect(
      normalizeIntent(
        ctx,
        {
          to: env.stranger(),
          amount: '1',
          fee: { fee: 1_000n, tip: { max: undefined } },
        },
        from,
      ),
    ).resolves.toMatchObject({ fee: { fee: 1_000n } });
    await expect(
      normalizeIntent(ctx, { to: env.stranger(), amount: '1', fee: undefined }, from),
    ).resolves.toBeDefined();
  });

  it('normalizeIntent rejects a fee override with a number or a class instance at any depth', async () => {
    const env = await createFakeEnv();
    const internals = internalsOf(env.bc);
    const pooled = await env.run(internals.pooled());
    const from = await env.run(env.bc.walletAddress());
    const ctx = {
      selection: internals.selection,
      driver: pooled.driver,
      assets: containerOf(env.aio).runtime.assets,
    };
    const reject = (fee: unknown) =>
      expect(
        normalizeIntent(
          ctx,
          { to: env.stranger(), amount: '1', fee: fee as never },
          from,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // At the top level.
    await reject({ gwei: 5 });
    await reject(new Date());
    await reject('lots');
    // At any depth: a number or a class instance nested inside an otherwise-plain
    // override must be rejected too, not just at the top level.
    await reject({ tip: { gwei: 5 } });
    await reject({ tip: [{ at: new Date() }] });
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

  it('ext rejects prototype-inherited property names instead of returning them', async () => {
    const env = await createFakeEnv();
    const loose = env.bc.ext as unknown as {
      fake: Record<'constructor' | 'toString', () => Promise<unknown>>;
    };
    await expect(env.run(loose.fake.constructor())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    await expect(env.run(loose.fake.toString())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
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
  it('closes and rejects further use with StateError, also through a handle pooled beforehand', async () => {
    const env = await createFakeEnv();
    await env.run(internalsOf(env.bc).pooled());
    await env.aio.close();
    const fresh = env.aio.blockchain({ chain: 'fakechain' });
    await expect(env.run(internalsOf(fresh).pooled())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(env.run(env.bc.getBlockHeight())).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
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

  it('resolves the lag tolerance: per-chain config, then root transport, then the plugin network', async () => {
    // Endpoint b is 10 blocks behind a; the fake plugin's network declares maxLagBlocks 2.
    const endpoints = ['a', { name: 'b', lag: 10 }];
    const stateOfB = async (env: FakeEnv, bc: Blockchain<FakeChainId>) => {
      const status = await env.run(bc.getNetworkStatus());
      const pooled = await env.run(internalsOf(bc).pooled());
      return [pooled.transport.maxLagBlocks, status.endpoints[1]?.state];
    };
    const plugin = await createFakeEnv({ endpoints });
    plugin.chain.mine(12);
    expect(await stateOfB(plugin, plugin.bc)).toEqual([2, 'lagging']);
    const own = plugin.aio.scope({ chains: { fakechain: { maxLagBlocks: 30 } } });
    expect(await stateOfB(plugin, own.blockchain({ chain: 'fakechain' }))).toEqual([
      30,
      'healthy',
    ]);

    const root = await createFakeEnv({ endpoints, transport: { maxLagBlocks: 20 } });
    root.chain.mine(12);
    expect(await stateOfB(root, root.bc)).toEqual([20, 'healthy']);
    const strict = root.aio.scope({ chains: { fakechain: { maxLagBlocks: 5 } } });
    expect(await stateOfB(root, strict.blockchain({ chain: 'fakechain' }))).toEqual([
      5,
      'lagging',
    ]);
    expect(
      thrown(() =>
        root.aio
          .scope({ chains: { fakechain: { maxLagBlocks: -1 } } })
          .blockchain({ chain: 'fakechain' }),
      ),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
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

  it('treats an unknown endpoint as usable when the transport has no health probes configured', async () => {
    const env = await createFakeEnv();
    // A factory that never calls transport.setProbes leaves the REAL pooled transport's
    // probes empty — done here by handing the fake driver factory a stand-in transport whose
    // setProbes is a no-op, so the pool's own transport (what ready() inspects) is untouched.
    const noProbes: AdapterManifest = {
      family: 'fake',
      library: 'no-probes-sdk',
      chains: ['fakechain'],
      capabilities: [],
      peerDependencies: [],
      load: async () => ({
        create: (ctx) =>
          fakeDriverFactory.create({
            ...ctx,
            transport: { setProbes: () => undefined } as unknown as Transport,
          }),
      }),
    };
    env.aio.use({ name: 'no-probes', adapters: [noProbes] });
    const bc = env.aio.blockchain({
      chain: 'fakechain',
      library: 'no-probes-sdk' as 'fake-sdk',
    });
    const pooled = await env.run(internalsOf(bc).pooled());
    expect(pooled.transport.hasProbes()).toBe(false);
    await expect(env.run(bc.ready())).resolves.toBe(bc);
    expect(pooled.transport.status()).toEqual([
      expect.objectContaining({ state: 'unknown' }),
    ]);
  });

  it('treats a half-open endpoint as usable', async () => {
    const env = await createFakeEnv({
      transport: { failureThreshold: 1, openMs: 1_000, maxAttempts: 1 },
    });
    env.chain.configureEndpoint('main', { down: true });
    // One failed 'read'-purpose call opens the breaker (failureThreshold: 1).
    await expect(env.run(env.bc.getBalance(env.address))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    const pooled = await env.run(internalsOf(env.bc).pooled());
    expect(pooled.transport.status()).toEqual([
      expect.objectContaining({ state: 'open' }),
    ]);
    await env.clock.advance(1_100);
    expect(pooled.transport.status()).toEqual([
      expect.objectContaining({ state: 'half-open' }),
    ]);
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

  it('refuses a reference cycle in its options with CONFIG_INVALID, not a stack overflow', () => {
    const nested: Record<string, unknown> = { depth: 1 };
    nested.again = [{ back: nested }];
    const options = { options: { nested } };
    for (const build of [
      () => new CryptoAio({ env: false, logger: noopLogger, chains: { c: options } }),
      () =>
        new CryptoAio({ env: false, logger: noopLogger }).scope({
          chains: { c: options },
        }),
    ]) {
      expect(thrown(build)).toMatchObject({
        code: 'CONFIG_INVALID',
        message: 'the configuration holds a reference cycle',
      });
    }
  });

  it('configure() never lets undefined override, nor __proto__ reach a map', () => {
    const hot = localSigner({ id: 'hot', secp256k1: secret(new Uint8Array(32).fill(1)) });
    configure({
      env: false,
      logger: noopLogger,
      signers: { hot },
      wallets: { main: { signer: 'hot' } },
      providers: { fake: { endpoints: [{ url: 'https://fake.test' }] } },
      lifecycle: { leaseMs: 5_000 },
      chains: { fakechain: { provider: 'fake' } },
    });
    const later = configure({
      signers: { hot: undefined },
      wallets: { main: undefined },
      providers: { fake: undefined },
      lifecycle: { leaseMs: undefined },
      ...JSON.parse('{"chains":{"__proto__":{"provider":"fake"}}}'),
    } as unknown as AioOptions);
    const effective = containerOf(later).effective();
    expect(effective.signers.hot).toBe(hot);
    expect(effective.wallets.main).toEqual({ signer: 'hot' });
    expect(effective.providers.fake).toBeDefined();
    expect(effective.lifecycle.leaseMs).toBe(5_000);
    expect(Object.getPrototypeOf(effective.chains)).toBe(Object.prototype);
    expect(Object.keys(effective.chains)).toEqual(['fakechain']);
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
      message: 'unknown wallet; none is configured',
    });
  });

  it("clones and deep-freezes each layer's wallets/chains/providers/signers so mutating the caller's options afterwards never reaches existing handles", async () => {
    const env = await createFakeEnv();
    const chains: Record<
      string,
      { provider: string; wallet: string; confirmations?: number }
    > = {
      fakechain: { provider: 'fake', wallet: 'main' },
    };
    const providers: Record<string, { endpoints: { url: string }[] }> = {
      fake: { endpoints: [{ url: env.chain.endpoint('m4') }] },
    };
    const wallets: Record<string, { signer: string }> = { main: { signer: 'hot' } };
    const signers: Record<string, Signer> = { hot: env.signer };
    const aio = new CryptoAio({
      env: false,
      logger: noopLogger,
      clock: env.clock,
      plugins: [fakePlugin()],
      transport: { fetch: env.chain.fetch },
      providers,
      signers,
      wallets,
      chains,
    });
    // Mutate every one of the caller's own objects AFTER construction.
    chains.fakechain = { provider: 'fake', wallet: 'main', confirmations: 99 };
    providers.fake = { endpoints: [{ url: env.chain.endpoint('m4-rogue') }] };
    wallets.main = { signer: 'rogue' };
    const rogueSigner = localSigner.generate({
      curves: ['secp256k1'],
      id: 'rogue',
    }).signer;
    signers.hot = rogueSigner;

    expect(aio.blockchain({ chain: 'fakechain' }).config.confirmations).toBe(2);
    // A handle built AFTER the mutations above still resolves through the ORIGINAL 'hot'
    // signer and the ORIGINAL 'm4' provider endpoint, proving the container read its own
    // frozen copies rather than the caller's live, since-mutated objects.
    const address = await env.run(aio.blockchain({ chain: 'fakechain' }).walletAddress());
    expect(address.canonical).toBe(env.address);

    const layer = containerOf(aio).layers[0];
    if (!layer) throw new Error('expected a root layer');
    expect(Object.isFrozen(layer.chains)).toBe(true);
    expect(Object.isFrozen(layer.chains?.fakechain)).toBe(true);
    expect(() => {
      (layer.chains as Record<string, unknown>).fakechain = {};
    }).toThrow();

    expect(Object.isFrozen(layer.providers)).toBe(true);
    expect(Object.isFrozen(layer.providers?.fake)).toBe(true);
    expect(layer.providers).not.toBe(providers);

    expect(Object.isFrozen(layer.wallets)).toBe(true);
    expect(Object.isFrozen(layer.wallets?.main)).toBe(true);
    expect(layer.wallets?.main).toEqual({ signer: 'hot' });

    // The signers MAP is a fresh, frozen copy; the Signer INSTANCE it holds is the same
    // object (referenced, not cloned).
    expect(Object.isFrozen(layer.signers)).toBe(true);
    expect(layer.signers).not.toBe(signers);
    expect(layer.signers?.hot).toBe(env.signer);
    expect(() => {
      (layer.signers as Record<string, unknown>).other = env.signer;
    }).toThrow();
  });

  it('keeps a plain-object signer opaque: the same object, with its own state, in every layer', async () => {
    const env = await createFakeEnv();
    const counted = {
      id: 'counted',
      schemes: env.signer.schemes,
      calls: 0,
      getPublicKey(scheme: string) {
        this.calls += 1;
        return env.signer.getPublicKey(scheme);
      },
      sign(...args: Parameters<Signer['sign']>) {
        this.calls += 1;
        return env.signer.sign(...args);
      },
    };
    const aio = new CryptoAio({
      env: false,
      logger: noopLogger,
      clock: env.clock,
      plugins: [fakePlugin()],
      transport: { fetch: env.chain.fetch },
      providers: { fake: { endpoints: [{ url: env.chain.endpoint('opaque') }] } },
      signers: { counted },
      wallets: { main: { signer: 'counted' } },
      chains: { fakechain: { provider: 'fake', wallet: 'main' } },
    });
    const scoped = aio.scope({ signers: { counted } });
    expect(containerOf(aio).effective().signers.counted).toBe(counted);
    expect(containerOf(scoped).effective().signers.counted).toBe(counted);

    const address = await env.run(
      scoped.blockchain({ chain: 'fakechain' }).walletAddress(),
    );
    expect(address.canonical).toBe(env.address);
    expect(counted.calls).toBe(1);
  });

  it('looks wallets up by own key only: an Object.prototype name is an unknown wallet', async () => {
    const env = await createFakeEnv();
    expect(
      thrown(() => env.aio.blockchain({ chain: 'fakechain', wallet: 'constructor' })),
    ).toMatchObject({
      name: 'ConfigError',
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/^unknown wallet; /),
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
