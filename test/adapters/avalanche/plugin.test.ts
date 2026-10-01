import { CryptoAio, secret, type NetworkInfo } from '../../../src';
import {
  AVALANCHE_CHAINS,
  AVALANCHE_P_CHAIN,
  AVALANCHE_X_CHAIN,
} from '../../../src/adapters/avalanche/chains';
import {
  AVALANCHE_CAPABILITIES,
  AVALANCHE_PEER_DEPENDENCIES,
} from '../../../src/adapters/avalanche/index';
import {
  avalancheManifest,
  avalanchePlugin,
} from '../../../src/adapters/avalanche/plugin';
import { AVALANCHE_PRESETS } from '../../../src/adapters/avalanche/presets';
import { avalancheNetworkConfig } from '../../../src/adapters/avalanche/network';
import { isId } from '../../../src/adapters/avalanche/cb58';
import { samePlugin } from '../../../src/core/registry/plugin';
import { reveal, type Secret } from '../../../src/core/secret/secret';
import { networkOf } from './support/vectors';

function endpointsOf(
  name: string,
  kind: 'rpc' | 'indexer',
  chain: string,
  network: string,
  apiKey?: string,
) {
  const preset = AVALANCHE_PRESETS.find(
    (p) => p.name === name && p.kind === kind && p.supports(chain, network),
  );
  if (!preset) throw new Error('no preset');
  return preset.endpoints({
    chain,
    network,
    ...(apiKey !== undefined ? { apiKey: secret(apiKey) } : {}),
  });
}

const urlOf = (value: string | Secret<string>) =>
  typeof value === 'string' ? value : reveal(value);

describe('the built-in Avalanche plugin', () => {
  it('registers the X-Chain and P-Chain, mainnet and Fuji, with AVAX of 9 decimals', () => {
    expect(AVALANCHE_CHAINS.map((c) => c.id)).toEqual(['avalanche-x', 'avalanche-p']);
    for (const chain of AVALANCHE_CHAINS) {
      expect(chain).toMatchObject({
        family: 'avalanche',
        model: 'utxo',
        ordering: 'inputs',
        schemes: ['secp256k1-ecdsa'],
        nativeAsset: { symbol: 'AVAX', decimals: 9 },
        defaultNetwork: 'mainnet',
      });
      expect(Object.keys(chain.networks)).toEqual(['mainnet', 'fuji']);
      expect(Object.isFrozen(chain.networks.mainnet?.params)).toBe(true);
      for (const network of Object.values(chain.networks)) {
        expect(isId(network.identity)).toBe(true);
        expect(network.finality).toEqual({ kind: 'confirmations', confirmations: 1 });
      }
    }
    expect(AVALANCHE_P_CHAIN.networks.fuji?.capabilities).toEqual({ remove: ['memo'] });
    expect(AVALANCHE_X_CHAIN.networks.fuji?.capabilities).toBeUndefined();
  });

  it('is the same plugin every time (A18) and registers with its peer dependency', async () => {
    expect(samePlugin(avalanchePlugin(), avalanchePlugin())).toBe(true);
    expect(avalancheManifest.peerDependencies).toEqual([
      AVALANCHE_PEER_DEPENDENCIES['@avalabs/avalanchejs'],
    ]);
    expect(avalancheManifest.capabilities).toBe(AVALANCHE_CAPABILITIES);
    expect(avalancheManifest.requiresIndexer).toBe(true);
    const aio = new CryptoAio({ env: false, plugins: [avalanchePlugin()] });
    const bc = aio.blockchain({ chain: 'avalanche-p', network: 'fuji' });
    expect([bc.chain, bc.network, bc.library]).toEqual([
      'avalanche-p',
      'fuji',
      '@avalabs/avalanchejs',
    ]);
    expect(bc.supports('memo')).toBe(false);
    expect(aio.blockchain({ chain: 'avalanche-x' }).supports('memo')).toBe(true);
    await aio.close();
  });

  it('keeps the C-Chain in the EVM family', () => {
    const aio = new CryptoAio({ env: false });
    expect(aio.blockchain({ chain: 'avalanche' }).library).toBe('ethers');
  });
});

describe('the Avalanche presets', () => {
  it.each([
    ['avalanche-x', 'mainnet', 'https://api.avax.network/ext/bc/X'],
    ['avalanche-p', 'mainnet', 'https://api.avax.network/ext/bc/P'],
    ['avalanche-x', 'fuji', 'https://api.avax-test.network/ext/bc/X'],
    ['avalanche-p', 'fuji', 'https://api.avax-test.network/ext/bc/P'],
  ])('public %s:%s is the chain API of Ava Labs', (chain, network, url) => {
    expect(endpointsOf('public', 'rpc', chain, network).map((e) => urlOf(e.url))).toEqual(
      [url],
    );
  });

  it.each([
    ['avalanche-x', 'mainnet', 'mainnet/blockchains/x-chain'],
    ['avalanche-p', 'fuji', 'fuji/blockchains/p-chain'],
  ])('the Data API indexer of %s:%s, keyless or keyed', (chain, network, path) => {
    const url = `https://data-api.avax.network/v1/networks/${path}`;
    expect(
      endpointsOf('public', 'indexer', chain, network).map((e) => urlOf(e.url)),
    ).toEqual([url]);
    const [keyed] = endpointsOf('glacier', 'indexer', chain, network, 'k'.repeat(32));
    expect(urlOf(keyed?.url ?? '')).toBe(url);
    const header = keyed?.headers?.['x-glacier-api-key'];
    expect(typeof header === 'string' ? header : reveal(header as Secret<string>)).toBe(
      'k'.repeat(32),
    );
    expect(String(header)).not.toContain('k'.repeat(32));
  });

  it('supports only its chains and networks, own keys only', () => {
    const [preset] = AVALANCHE_PRESETS;
    expect(preset?.supports('avalanche-x', 'fuji')).toBe(true);
    expect(preset?.supports('avalanche', 'mainnet')).toBe(false);
    expect(preset?.supports('avalanche-x', 'toString')).toBe(false);
    expect(preset?.supports('constructor', 'mainnet')).toBe(false);
    expect(() => preset?.endpoints({ chain: 'avalanche-x', network: 'local' })).toThrow(
      'no Avalanche endpoint',
    );
  });

  it('refuses an empty key without echoing it', () => {
    expect(() => endpointsOf('glacier', 'indexer', 'avalanche-x', 'fuji', ' ')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message:
          "provider preset 'glacier' requires a non-empty apiKey for avalanche-x:fuji",
      }),
    );
  });
});

describe('Avalanche network config', () => {
  const X = AVALANCHE_X_CHAIN;
  const fuji = networkOf('avm');
  const config = (patch: Partial<NetworkInfo>, options = {}) =>
    avalancheNetworkConfig(X, { ...fuji, ...patch }, options);
  const params = (patch: Record<string, unknown>) => ({
    params: { ...fuji.params, ...patch },
  });

  it('reads the built-in networks', () => {
    expect(config({})).toMatchObject({
      vm: 'avm',
      alias: 'X',
      networkId: 5,
      hrp: 'fuji',
      confirmations: 1,
      maxFee: 100_000_000n,
      maxGasPrice: 10_000n,
    });
    expect(config({}, { maxFee: 5n, maxGasPrice: 7n })).toMatchObject({
      maxFee: 5n,
      maxGasPrice: 7n,
    });
  });

  it.each([
    [params({ vm: 'evm' }), "params.vm must be 'avm' or 'pvm'"],
    [params({ alias: 'P' }), "params.alias must be 'X' for the avm chain"],
    [{ feeModel: 'utxo' }, "fee model 'utxo' is not 'avalanche-static'"],
    [params({ networkId: 0 }), 'params.networkId must be an integer from 1 to 2^32 - 1'],
    [
      params({ hrp: 'Fuji' }),
      'params.hrp must be a lowercase human-readable part of 1 to 40 letters',
    ],
    [params({ blockchainId: 'x' }), 'params.blockchainId must be a CB58 id of 32 bytes'],
    [params({ avaxAssetId: 1 }), 'params.avaxAssetId must be a CB58 id of 32 bytes'],
    [{ identity: 'abc' }, 'its identity must be the CB58 id of the block at height 0'],
    [
      { finality: { kind: 'solidified' } },
      "finality 'solidified' is not an Avalanche policy (use 'confirmations')",
    ],
    [
      { finality: { kind: 'confirmations', confirmations: 0 } },
      'finality.confirmations must be a safe integer >= 1',
    ],
    [{ capabilities: { add: ['tokens'] } }, "capabilities.add: 'tokens' is not one"],
    [{ capabilities: { remove: ['nonsense'] } }, 'capabilities.remove: an unknown name'],
    [
      { capabilities: { add: 'memo' as never } },
      'capabilities.add and capabilities.remove must be lists',
    ],
  ] as const)('refuses a bad network: %j', (patch, reason) => {
    expect(() => config(patch as Partial<NetworkInfo>)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining(reason),
      }),
    );
  });

  it('refuses unknown or bad options without echoing the key', () => {
    expect(() => config({}, { 'sk-secret-key': 1 })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sk-secret-key'),
      }),
    );
    expect(() => config({}, { maxFee: 0n })).toThrow(
      'options.maxFee must be a bigint >= 1',
    );
    expect(() => config({}, { maxGasPrice: 3 })).toThrow(
      'options.maxGasPrice must be a bigint >= 1',
    );
  });

  it('serves a capability removal', () => {
    expect([
      ...config({ capabilities: { remove: ['batch-transfer'] } }).capabilities,
    ]).not.toContain('batch-transfer');
  });
});
