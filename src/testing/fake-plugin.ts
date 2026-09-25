import type { AdapterManifest, DriverFactory } from '../core/driver/types';
import type { ChainInfo, NetworkInfo } from '../core/model/chain';
import type { Plugin } from '../core/registry/plugin';
import type { FakeExt, FakeNativeClient } from './fake-driver';

// R37: augment the registries through the public entry module, as users do with
// 'crypto-aio'. Augmenting core/model/ids directly makes a user's own augmentation depend on
// the order in which the compiler reads files.
declare module '../index' {
  interface ChainRegistry {
    fakechain: { family: 'fake'; network: 'local' };
    fakeexpiry: { family: 'fake'; network: 'local' };
    fakeseqno: { family: 'fake'; network: 'local' };
  }
  interface FamilyRegistry {
    fake: { library: 'fake-sdk'; ext: FakeExt };
  }
  interface NativeClientMap {
    'fake-sdk': FakeNativeClient;
  }
}

const network = (extra: Partial<NetworkInfo> = {}): NetworkInfo => ({
  id: 'local',
  identity: 'fake-local',
  testnet: true,
  feeModel: 'fake',
  finality: { kind: 'tag', tag: 'finalized', fallbackConfirmations: 3 },
  defaultConfirmations: 2,
  reorgWindow: 16,
  maxLagBlocks: 2,
  replacement: { minBumpPercent: 10 },
  explorer: {
    tx: 'https://explorer.fake/tx/{id}',
    address: 'https://explorer.fake/address/{address}',
  },
  ...extra,
});

const chain = (
  id: string,
  ordering: ChainInfo['ordering'],
  extra: Partial<NetworkInfo> = {},
): ChainInfo => ({
  id,
  family: 'fake',
  model: 'account',
  ordering,
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'FAKE', decimals: 8, name: 'Fake coin' },
  defaultNetwork: 'local',
  networks: { local: network(extra) },
});

export const fakeManifest: AdapterManifest = {
  family: 'fake',
  library: 'fake-sdk',
  chains: ['fakechain', 'fakeexpiry', 'fakeseqno'],
  capabilities: [
    'memo',
    'block-scan',
    'replace-fee',
    'cancel',
    'finality-tag',
    'hd-public-derivation',
  ],
  peerDependencies: [],
  load: async (): Promise<DriverFactory> => {
    // Mirrors real adapters: the driver module is only loaded on first use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./fake-driver') as typeof import('./fake-driver');
    return mod.fakeDriverFactory;
  },
};

export function fakePlugin(): Plugin {
  return {
    name: 'fake',
    chains: [
      chain('fakechain', 'nonce'),
      chain('fakeexpiry', 'expiry', {
        capabilities: { add: ['expiry'], remove: ['replace-fee', 'cancel'] },
      }),
      chain('fakeseqno', 'seqno', {
        capabilities: { remove: ['replace-fee', 'cancel'] },
      }),
    ],
    adapters: [fakeManifest],
  };
}
