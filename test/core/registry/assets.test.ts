import {
  assetId,
  isAssetId,
  parseAssetId,
  sameAssetRef,
} from '../../../src/core/model/asset';
import type { ChainInfo } from '../../../src/core/model/chain';
import { AssetCatalog } from '../../../src/core/registry/assets';
import { thrown } from '../../helpers';

const chain: ChainInfo = {
  id: 'testchain',
  family: 'test',
  model: 'account',
  ordering: 'nonce',
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'TST', decimals: 18 },
  defaultNetwork: 'local',
  networks: {
    local: {
      id: 'local',
      testnet: true,
      feeModel: 'flat',
      finality: { kind: 'confirmations', confirmations: 1 },
      defaultConfirmations: 1,
      reorgWindow: 3,
    },
    other: {
      id: 'other',
      testnet: true,
      feeModel: 'flat',
      finality: { kind: 'confirmations', confirmations: 1 },
      defaultConfirmations: 1,
      reorgWindow: 3,
    },
  },
};
const usdt = { standard: 'erc20', contract: '0xdac1' } as const;

describe('asset ids', () => {
  it('builds and parses canonical ids', () => {
    expect(assetId('testchain', 'local', 'native')).toBe('testchain:local/native');
    expect(assetId('testchain', 'local', usdt)).toBe('testchain:local/erc20:0xdac1');
    expect(parseAssetId('testchain:local/erc20:0xdac1')).toEqual({
      chain: 'testchain',
      network: 'local',
      ref: usdt,
    });
    expect(parseAssetId('testchain:local/native').ref).toBe('native');
    expect(isAssetId('USDT')).toBe(false);
    expect(thrown(() => parseAssetId('USDT'))).toMatchObject({
      code: 'ASSET_RESOLUTION',
    });
    expect(sameAssetRef(usdt, { standard: 'erc20', contract: '0xdac1' })).toBe(true);
    expect(sameAssetRef('native', usdt)).toBe(false);
  });
});

describe('AssetCatalog', () => {
  it('registers native assets per network with the symbol as alias', () => {
    const catalog = new AssetCatalog();
    catalog.registerNative(chain);
    expect(catalog.native('testchain', 'other').id).toBe('testchain:other/native');
    expect(catalog.resolveAlias('testchain', 'local', 'tst').id).toBe(
      'testchain:local/native',
    );
  });

  it('resolves aliases only within one chain and network', () => {
    const catalog = new AssetCatalog();
    catalog.registerNative(chain);
    catalog.register({
      chain: 'testchain',
      network: 'local',
      ref: usdt,
      metadata: { symbol: 'USDT', decimals: 6 },
      aliases: ['USDT'],
    });
    expect(catalog.resolveAlias('testchain', 'local', ' usdt ').metadata.decimals).toBe(
      6,
    );
    expect(
      thrown(() => catalog.resolveAlias('testchain', 'other', 'USDT')),
    ).toMatchObject({
      code: 'ASSET_RESOLUTION',
      message: expect.stringMatching(
        /unknown asset alias 'USDT' on testchain:other \(known: TST\)/,
      ),
    });
  });

  it('rejects conflicting aliases and conflicting metadata', () => {
    const catalog = new AssetCatalog();
    catalog.register({
      chain: 'testchain',
      network: 'local',
      ref: usdt,
      metadata: { symbol: 'USDT', decimals: 6 },
      aliases: ['USDT'],
    });
    expect(
      thrown(() =>
        catalog.register({
          chain: 'testchain',
          network: 'local',
          ref: { standard: 'erc20', contract: '0xfake' },
          metadata: { symbol: 'USDT', decimals: 6 },
          aliases: ['usdt'],
        }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/already refers to/),
    });
    expect(
      thrown(() =>
        catalog.register({
          chain: 'testchain',
          network: 'local',
          ref: usdt,
          metadata: { symbol: 'USDT', decimals: 18 },
        }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/different metadata/),
    });
    expect(
      thrown(() =>
        catalog.register({
          chain: 'testchain',
          network: 'local',
          ref: 'native',
          metadata: { symbol: '', decimals: 1 },
        }),
      ),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('is idempotent for identical registrations and clones independently', () => {
    const catalog = new AssetCatalog();
    const reg = {
      chain: 'testchain',
      network: 'local',
      ref: usdt,
      metadata: { symbol: 'USDT', decimals: 6 },
      aliases: ['USDT'],
    };
    const first = catalog.register(reg);
    expect(catalog.register(reg)).toBe(first);
    const copy = catalog.clone();
    copy.register({
      ...reg,
      ref: { standard: 'erc20', contract: '0x2' },
      aliases: ['X'],
    });
    expect(thrown(() => catalog.resolveAlias('testchain', 'local', 'X'))).toMatchObject({
      code: 'ASSET_RESOLUTION',
    });
  });
});
