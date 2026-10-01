import type { AdapterManifest } from '../../../src/core/driver/types';
import { readEnvChains, envChainKey } from '../../../src/core/config/env';
import { mergeScopes } from '../../../src/core/config/merge';
import { describeSelection, resolveSelection } from '../../../src/core/config/resolve';
import type { HandleOptions, ScopeOptions } from '../../../src/core/config/types';
import { noopLogger } from '../../../src/core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { applyPlugin, createCatalogs } from '../../../src/core/registry/plugin';
import type { ProviderPreset } from '../../../src/core/registry/providers';
import { reveal, secret } from '../../../src/core/secret/secret';
import { localSigner } from '../../../src/core/signing/local';
import { thrown } from '../../helpers';

const net = (id: string, extra: Partial<NetworkInfo> = {}): NetworkInfo => ({
  id,
  testnet: true,
  feeModel: 'flat',
  finality: { kind: 'confirmations', confirmations: 2 },
  defaultConfirmations: 2,
  reorgWindow: 5,
  ...extra,
});
const chain = (id: string, schemes: string[] = ['secp256k1-ecdsa']): ChainInfo => ({
  id,
  family: 'test',
  model: 'account',
  ordering: 'nonce',
  schemes,
  nativeAsset: { symbol: 'TST', decimals: 18 },
  defaultNetwork: 'local',
  networks: {
    local: net('local'),
    other: net('other', { capabilities: { add: ['fee-market-1559'], remove: ['memo'] } }),
  },
});
const manifest = (
  library: string,
  chains: string[],
  extra: Partial<AdapterManifest> = {},
): AdapterManifest => ({
  family: 'test',
  library,
  chains,
  capabilities: ['memo'],
  indexerCapabilities: ['address-history'],
  peerDependencies: [],
  load: async () => ({
    create: async () => {
      throw new Error('unused');
    },
  }),
  ...extra,
});
const acme: ProviderPreset = {
  name: 'acme',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (c) => c === 'testchain',
  endpoints: ({ network, apiKey }) => [
    { name: 'main', url: secret(`https://acme.test/${network}/${reveal(apiKey ?? '')}`) },
  ],
};
const publicPreset: ProviderPreset = {
  name: 'public',
  kind: 'rpc',
  production: false,
  supports: (c, n) => c === 'testchain' && n === 'local',
  endpoints: () => [{ url: 'https://public.test' }],
};
const idx: ProviderPreset = {
  name: 'idx',
  kind: 'indexer',
  supports: () => true,
  endpoints: () => [{ url: 'https://idx.test' }],
};

const catalogs = createCatalogs();
applyPlugin(catalogs, {
  name: 'test',
  chains: [chain('testchain'), chain('otherchain'), chain('edchain', ['ed25519'])],
  adapters: [
    manifest('lib-a', ['testchain', 'edchain']),
    manifest('lib-b', ['testchain']),
    manifest('lib-c', ['otherchain']),
  ],
  presets: [acme, publicPreset, idx],
});
const hot = localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
const root: ScopeOptions = {
  providers: { acme: { preset: 'acme', apiKey: secret('ROOTKEY') } },
  signers: { hot },
  wallets: {
    main: { signer: 'hot' },
    restricted: { signer: 'hot', chains: ['otherchain'] },
  },
};
const resolve = (handle: HandleOptions, layers: ScopeOptions[] = [root]) =>
  resolveSelection({ handle, effective: mergeScopes(layers), catalogs, log: noopLogger });

describe('resolveSelection', () => {
  it('fills defaults from the registry and falls back to the public preset', () => {
    const warnings: string[] = [];
    const sel = resolveSelection({
      handle: { chain: 'testchain' },
      effective: mergeScopes([root]),
      catalogs,
      log: { ...noopLogger, warn: (m) => warnings.push(m) },
    });
    expect(sel.network.id).toBe('local');
    expect(sel.library).toBe('lib-a');
    expect(sel.providers).toEqual([
      expect.objectContaining({ name: 'public', production: false }),
    ]);
    expect(sel.confirmations).toBe(2);
    expect(warnings).toEqual([expect.stringMatching(/public provider/)]);
  });

  it('applies precedence handle > scope > root > env', () => {
    const env: ScopeOptions = {
      chains: { testchain: { network: 'other', provider: 'acme' } },
    };
    const scope: ScopeOptions = { chains: { testchain: { network: 'local' } } };
    expect(resolve({ chain: 'testchain' }, [env, root]).network.id).toBe('other');
    expect(resolve({ chain: 'testchain' }, [env, root, scope]).network.id).toBe('local');
    expect(
      resolve({ chain: 'testchain', network: 'other' }, [env, root, scope]).network.id,
    ).toBe('other');
  });

  it('replaces provider lists instead of merging them', () => {
    const base: ScopeOptions = {
      ...root,
      chains: { testchain: { provider: ['acme', 'public'] } },
    };
    const scope: ScopeOptions = { chains: { testchain: { provider: 'public' } } };
    expect(resolve({ chain: 'testchain' }, [base]).providers.map((p) => p.name)).toEqual([
      'acme',
      'public',
    ]);
    expect(
      resolve({ chain: 'testchain' }, [base, scope]).providers.map((p) => p.name),
    ).toEqual(['public']);
  });

  it('fails fast on incompatible or unknown selections', () => {
    expect(thrown(() => resolve({ chain: 'testchain', library: 'lib-c' }))).toMatchObject(
      {
        code: 'INCOMPATIBLE_SELECTION',
        message:
          "unknown library for chain 'testchain'; the accepted names are 'lib-a' and 'lib-b'",
      },
    );
    expect(thrown(() => resolve({ chain: 'nope' }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(thrown(() => resolve({ chain: 'testchain', network: 'main' }))).toMatchObject({
      message: expect.stringMatching(/the accepted names are 'local' and 'other'/),
    });
    expect(
      thrown(() => resolve({ chain: 'testchain', provider: 'ghost' })),
    ).toMatchObject({
      message: expect.stringMatching(/^unknown rpc provider; the accepted names are /),
    });
    expect(
      thrown(() => resolve({ chain: 'otherchain', provider: 'acme' })),
    ).toMatchObject({
      message: expect.stringMatching(/does not support otherchain:local/),
    });
    expect(thrown(() => resolve({ chain: 'otherchain' }))).toMatchObject({
      message: expect.stringMatching(/no provider configured for otherchain:local/),
    });
  });

  it('validates wallets and signer schemes', () => {
    expect(
      resolve({ chain: 'testchain', provider: 'acme', wallet: 'main' }).signer?.id,
    ).toBe('hot');
    expect(
      thrown(() => resolve({ chain: 'testchain', provider: 'acme', wallet: 'ghost' })),
    ).toMatchObject({ message: expect.stringMatching(/^unknown wallet; /) });
    // Own-key lookups: inherited Object.prototype names are unknown, not "found".
    expect(
      thrown(() => resolve({ chain: 'testchain', provider: 'acme', wallet: 'toString' })),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/^unknown wallet; /),
    });
    expect(
      thrown(() => resolve({ chain: 'testchain', provider: 'toString' })),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/^unknown rpc provider; /),
    });
    expect(
      thrown(() =>
        resolve({ chain: 'testchain', provider: 'acme', signer: '__proto__' }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/^unknown signer; /),
    });
    expect(
      thrown(() =>
        resolve({ chain: 'testchain', provider: 'acme', wallet: 'restricted' }),
      ),
    ).toMatchObject({
      message: expect.stringMatching(/not enabled for chain 'testchain'/),
    });
    expect(
      thrown(() =>
        resolve({
          chain: 'edchain',
          provider: { endpoints: [{ url: 'https://ed.test' }] },
          wallet: 'main',
        }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(
        /signer 'hot' supports .* but chain 'edchain' needs one of ed25519/,
      ),
    });
  });

  it('computes capabilities from manifest, indexer and network', () => {
    const plain = resolve({ chain: 'testchain', provider: 'acme' });
    expect([...plain.capabilities].sort()).toEqual(['memo']);
    const rich = resolve({
      chain: 'testchain',
      network: 'other',
      provider: 'acme',
      indexer: 'idx',
    });
    expect([...rich.capabilities].sort()).toEqual(['address-history', 'fee-market-1559']);
  });

  it('derives stable pool keys that separate credentials, and never leaks secrets', () => {
    const a = resolve({ chain: 'testchain', provider: 'acme' });
    const b = resolve({ chain: 'testchain', provider: 'acme' });
    const c = resolve({ chain: 'testchain', provider: 'acme' }, [
      { ...root, providers: { acme: { preset: 'acme', apiKey: secret('OTHERKEY') } } },
    ]);
    expect(a.poolKey).toBe(b.poolKey);
    expect(a.poolKey).not.toBe(c.poolKey);
    expect(a.configHash).toBe(b.configHash);
    expect(Object.isFrozen(a)).toBe(true);
    const snapshot = JSON.stringify(describeSelection(a));
    expect(snapshot).not.toContain('ROOTKEY');
    expect(snapshot).toContain('acme.test');
    expect(JSON.stringify(a.providers)).not.toContain('ROOTKEY');
  });

  it('names inline providers without revealing their secrets', () => {
    const sel = resolve({
      chain: 'testchain',
      provider: {
        endpoints: [{ url: secret('https://inline.test/SECRETPATH0123456789') }],
      },
    });
    expect(sel.providerNames[0]).toMatch(/^inline:[0-9a-f]{8}$/);
    expect(sel.providers[0]?.endpoints[0]?.name).toMatch(/^inline:[0-9a-f]{8}\/0$/);
  });

  it('produces the same poolKey and configHash regardless of key insertion order', () => {
    const layerA: ScopeOptions = {
      ...root,
      chains: { testchain: { options: { a: 1, b: 2 } } },
    };
    const layerB: ScopeOptions = {
      ...root,
      chains: { testchain: { options: { b: 2, a: 1 } } },
    };
    const selA = resolve({ chain: 'testchain', provider: 'acme' }, [layerA]);
    const selB = resolve({ chain: 'testchain', provider: 'acme' }, [layerB]);
    expect(selA.poolKey).toBe(selB.poolKey);
    expect(selA.configHash).toBe(selB.configHash);
  });

  it('deep-freezes options, including nested objects, and the providers array', () => {
    const sel = resolve({ chain: 'testchain', provider: 'acme' }, [
      { ...root, chains: { testchain: { options: { nested: { x: 1 } } } } },
    ]);
    expect(Object.isFrozen(sel.options)).toBe(true);
    expect(Object.isFrozen(sel.options.nested)).toBe(true);
    expect(Object.isFrozen(sel.providers)).toBe(true);
  });
});

describe('merge safety', () => {
  it('does not alias nested option objects from input layers', () => {
    const layer: ScopeOptions = { chains: { c: { options: { nested: { x: 1 } } } } };
    const eff = mergeScopes([layer]);
    const mergedNested = eff.chains.c?.options?.nested as { x: number } | undefined;
    expect(mergedNested).toEqual({ x: 1 });
    if (mergedNested) mergedNested.x = 42;
    const inputNested = layer.chains?.c?.options?.nested as { x: number } | undefined;
    expect(inputNested).toEqual({ x: 1 });
  });

  it('guards against __proto__ pollution of named maps', () => {
    const layer = JSON.parse('{"providers":{"__proto__":{"evil":{"preset":"x"}}}}');
    const eff = mergeScopes([layer]);
    expect(eff.providers.evil).toBeUndefined();
    expect(Object.getPrototypeOf(eff.providers)).toBe(Object.prototype);
  });
});

describe('environment', () => {
  it('reads routing keys with profile precedence and wraps URLs as secrets', () => {
    expect(envChainKey('avalanche-c')).toBe('AVALANCHE_C');
    const env = {
      CRYPTO_AIO_ENV: 'test',
      CRYPTO_AIO_TEST_TESTCHAIN_NETWORK: 'other',
      CRYPTO_AIO_TESTCHAIN_NETWORK: 'local',
      CRYPTO_AIO_TESTCHAIN_RPC_URL: 'https://rpc.test/KEY123',
      CRYPTO_AIO_TESTCHAIN_INDEXER_URL: 'https://idx.test/KEY456',
      CRYPTO_AIO_OTHERCHAIN_PROVIDER: 'acme',
      CRYPTO_AIO_OTHERCHAIN_RPC_URL: 'https://ignored.test',
      CRYPTO_AIO_TESTCHAIN_PRIVATE_KEY: 'never-read',
    };
    const chains = readEnvChains(env, ['testchain', 'otherchain', 'edchain']);
    expect(chains.testchain?.network).toBe('other');
    expect(chains.otherchain?.provider).toBe('acme');
    expect(chains.edchain).toBeUndefined();
    const text = JSON.stringify(chains);
    expect(text).not.toContain('KEY123');
    expect(text).not.toContain('KEY456');
    expect(text).not.toContain('never-read');
    expect(readEnvChains(env, ['testchain'], 'prod').testchain?.network).toBe('local');
  });
});
