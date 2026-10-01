import {
  explorerUrl,
  type ChainInfo,
  type NetworkInfo,
} from '../../../src/core/model/chain';
import { ChainCatalog } from '../../../src/core/registry/chains';
import { thrown } from '../../helpers';

const network = (id: string, extra: Partial<NetworkInfo> = {}): NetworkInfo => ({
  id,
  testnet: true,
  feeModel: 'flat',
  finality: { kind: 'confirmations', confirmations: 2 },
  defaultConfirmations: 1,
  reorgWindow: 5,
  ...extra,
});

const chain = (extra: Partial<ChainInfo> = {}): ChainInfo => ({
  id: 'testchain',
  family: 'test',
  model: 'account',
  ordering: 'nonce',
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'TST', decimals: 18 },
  defaultNetwork: 'local',
  networks: {
    local: network('local', {
      explorer: {
        tx: 'https://x.io/tx/{id}',
        address: 'https://x.io/a/{address}',
      },
    }),
    other: network('other'),
  },
  ...extra,
});

describe('ChainCatalog', () => {
  it('registers, lists and resolves networks', () => {
    const catalog = new ChainCatalog();
    catalog.register(chain());
    expect(catalog.has('testchain')).toBe(true);
    expect(catalog.get('testchain').family).toBe('test');
    expect(catalog.list().map((c) => c.id)).toEqual(['testchain']);
    expect(catalog.network('testchain', 'other').id).toBe('other');
  });

  it('rejects duplicates and unknown ids with helpful messages', () => {
    const catalog = new ChainCatalog();
    catalog.register(chain());
    expect(thrown(() => catalog.register(chain()))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/already registered/),
    });
    expect(thrown(() => catalog.get('nope'))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: "unknown chain; the only accepted name is 'testchain'",
    });
    expect(thrown(() => catalog.network('testchain', 'main'))).toMatchObject({
      message:
        "unknown network for chain 'testchain'; the accepted names are 'local' and 'other'",
    });
  });

  it('validates chain definitions', () => {
    const catalog = new ChainCatalog();
    expect(thrown(() => catalog.register(chain({ id: 'Bad Id' })))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(
      thrown(() => catalog.register(chain({ defaultNetwork: 'missing' }))),
    ).toMatchObject({
      message: expect.stringMatching(/default network/),
    });
    expect(
      thrown(() =>
        catalog.register(chain({ nativeAsset: { symbol: 'X', decimals: 1.5 } })),
      ),
    ).toMatchObject({ message: expect.stringMatching(/decimals/) });
    expect(
      thrown(() =>
        catalog.register(
          chain({ networks: { local: network('local', { reorgWindow: 0 }) } }),
        ),
      ),
    ).toMatchObject({ message: expect.stringMatching(/reorgWindow/) });
    expect(thrown(() => catalog.register(chain({ schemes: [] })))).toMatchObject({
      message: expect.stringMatching(/signature scheme/),
    });
  });

  it('clones independently', () => {
    const a = new ChainCatalog();
    const b = a.clone();
    b.register(chain());
    expect(a.has('testchain')).toBe(false);
  });

  it('renders explorer links', () => {
    const local = chain().networks.local as NetworkInfo;
    expect(explorerUrl(local, 'tx', 'ab/c')).toBe('https://x.io/tx/ab%2Fc');
    expect(explorerUrl(local, 'address', 'q')).toBe('https://x.io/a/q');
    expect(explorerUrl(network('n'), 'tx', 'x')).toBeUndefined();
  });
});
