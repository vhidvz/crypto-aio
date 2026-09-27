import { TON_CHAINS } from '../../../src/adapters/ton/chains';
import { TON_PRESETS } from '../../../src/adapters/ton/presets';
import { TON_TOKENS } from '../../../src/adapters/ton/tokens';
import { explorerUrl } from '../../../src/core/model/chain';
import { applyPlugin, createCatalogs } from '../../../src/core/registry/plugin';
import { isSecret, reveal, secret } from '../../../src/core/secret/secret';

function catalogs() {
  const all = createCatalogs();
  applyPlugin(all, {
    name: 'ton-data',
    chains: TON_CHAINS,
    presets: TON_PRESETS,
    assets: TON_TOKENS,
  });
  return all;
}

const USDT = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('TON chain data', () => {
  it('registers ton with its global ids as network identities (spec §2)', () => {
    const chain = catalogs().chains.get('ton');
    expect(chain).toMatchObject({
      family: 'ton',
      model: 'account',
      ordering: 'seqno',
      schemes: ['ed25519'],
      defaultNetwork: 'mainnet',
      nativeAsset: { symbol: 'GRAM', decimals: 9, name: 'Gram' },
    });
    expect(
      Object.values(chain.networks).map((n) => [n.id, n.identity, n.testnet]),
    ).toEqual([
      ['mainnet', '-239', false],
      ['testnet', '-3', true],
    ]);
  });

  it('keeps masterchain finality, the fee model, lag and library policies per network', () => {
    for (const network of Object.values(TON_CHAINS[0]?.networks ?? {})) {
      expect(network).toMatchObject({
        feeModel: 'ton',
        finality: { kind: 'masterchain' },
        defaultConfirmations: 1,
        maxLagBlocks: 150,
        params: {
          validForSeconds: 60,
          jettonAttached: 50_000_000n,
          jettonForwardAmount: 1n,
          finalitySkewBlocks: 10,
        },
      });
      expect(network.replacement).toBeUndefined();
      expect(network.capabilities).toBeUndefined();
    }
  });

  it('links transactions and addresses to tonviewer', () => {
    const { mainnet, testnet } = TON_CHAINS[0]?.networks ?? {};
    const hash = 'fc9b45a62efb7b39f91df4df72be1bb0e2b227e80bcaeb348fcb67b89840aa85';
    expect(explorerUrl(mainnet!, 'tx', hash)).toBe(
      `https://tonviewer.com/transaction/${hash}`,
    );
    expect(
      explorerUrl(
        testnet!,
        'address',
        'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI',
      ),
    ).toBe(
      'https://testnet.tonviewer.com/UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI',
    );
  });

  it('is frozen all the way down (R56)', () => {
    expect(isDeepFrozen(TON_CHAINS)).toBe(true);
    expect(isDeepFrozen(TON_TOKENS)).toBe(true);
    expect(isDeepFrozen(TON_PRESETS)).toBe(true);
  });
});

describe('TON assets', () => {
  it('resolves the native coin as GRAM or TON, and USDT only on mainnet', () => {
    const { assets } = catalogs();
    for (const network of ['mainnet', 'testnet']) {
      expect(assets.resolveAlias('ton', network, 'GRAM').id).toBe(
        `ton:${network}/native`,
      );
      expect(assets.resolveAlias('ton', network, 'ton').id).toBe(`ton:${network}/native`);
    }
    expect(assets.resolveAlias('ton', 'mainnet', 'USDT')).toMatchObject({
      id: `ton:mainnet/jetton:${USDT}`,
      ref: { standard: 'jetton', contract: USDT },
      metadata: { symbol: 'USDT', decimals: 6 },
    });
    expect(() => assets.resolveAlias('ton', 'testnet', 'USDT')).toThrow(
      expect.objectContaining({ code: 'ASSET_RESOLUTION' }),
    );
  });

  it("gives the TON alias the chain's own native metadata, so the two cannot drift", () => {
    const natives = TON_TOKENS.filter((token) => token.ref === 'native');
    expect(natives.map((token) => token.network)).toEqual(['mainnet', 'testnet']);
    for (const token of natives) {
      expect(token.metadata).toEqual(TON_CHAINS[0]?.nativeAsset);
    }
  });
});

describe('TON provider presets', () => {
  const input = (network: string, apiKey?: string) => ({
    chain: 'ton',
    network,
    ...(apiKey !== undefined ? { apiKey: secret(apiKey) } : {}),
  });

  it('serves toncenter v2 as rpc and v3 as indexer, keyless and not for production', () => {
    const { presets } = catalogs();
    expect(presets.resolve('public', input('mainnet'), 'rpc')).toMatchObject({
      endpoints: [{ url: 'https://toncenter.com/api/v2', rateLimit: { rps: 0.5 } }],
      preset: { production: false },
    });
    expect(presets.resolve('public', input('testnet'), 'indexer').endpoints).toEqual([
      {
        name: 'toncenter',
        url: 'https://testnet.toncenter.com/api/v3',
        rateLimit: { rps: 0.5 },
      },
    ]);
  });

  it('budgets v2 and v3 within one toncenter limit: 1 rps keyless, 10 with a free key (X2, M16)', () => {
    const { presets } = catalogs();
    const budget = (name: string, apiKey?: string) =>
      (['rpc', 'indexer'] as const).map(
        (kind) =>
          presets.resolve(name, input('mainnet', apiKey), kind).endpoints[0]?.rateLimit
            ?.rps,
      );
    expect(budget('public')).toEqual([0.5, 0.5]);
    expect(budget('toncenter', 'k')).toEqual([5, 5]);
  });

  it('puts the toncenter key in a secret header, never in the URL', () => {
    const { presets } = catalogs();
    for (const kind of ['rpc', 'indexer'] as const) {
      const [endpoint] = presets.resolve(
        'toncenter',
        input('mainnet', 'k-123'),
        kind,
      ).endpoints;
      expect(String(endpoint?.url)).not.toContain('k-123');
      const header = endpoint?.headers?.['X-API-Key'];
      expect(isSecret(header)).toBe(true);
      expect(reveal(header as never)).toBe('k-123');
      expect(JSON.stringify(endpoint)).not.toContain('k-123');
    }
  });

  it('refuses a missing or empty key, and other chains, with CONFIG_INVALID', () => {
    const { presets } = catalogs();
    expect(() => presets.resolve('toncenter', input('mainnet'), 'rpc')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    let error: unknown;
    try {
      presets.resolve('toncenter', input('testnet', '   '), 'indexer');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('non-empty apiKey'),
    });
    expect(() =>
      presets.resolve('toncenter', { chain: 'ethereum', network: 'mainnet' }, 'rpc'),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('supports only its own networks, never an inherited key', () => {
    const { presets } = catalogs();
    for (const network of ['constructor', 'toString', '__proto__']) {
      for (const preset of TON_PRESETS)
        expect(preset.supports('ton', network)).toBe(false);
      for (const [name, apiKey] of [
        ['public', undefined],
        ['toncenter', 'k'],
      ] as const) {
        for (const kind of ['rpc', 'indexer'] as const) {
          expect(() => presets.resolve(name, input(network, apiKey), kind)).toThrow(
            expect.objectContaining({ code: 'CONFIG_INVALID' }),
          );
        }
      }
    }
  });
});
