// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('@ton/core', () => {
  throw Object.assign(
    new Error("Cannot find module '@ton/core' from 'src/adapters/ton/wallets.ts'"),
    { code: 'MODULE_NOT_FOUND' },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing TON SDK', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: {
        v2: { endpoints: [{ url: 'https://node.invalid/api/v2' }] },
        v3: { endpoints: [{ url: 'https://node.invalid/api/v3', kind: 'indexer' }] },
      },
    });
    const ton = aio.blockchain({
      chain: 'ton',
      network: 'testnet',
      provider: 'v2',
      indexer: 'v3',
    });
    await expect(ton.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message:
        "library '@ton/ton' (ton) needs @ton/core; install it: npm i @ton/core@^0.63.1",
      details: { packages: ['@ton/core'] },
      cause: expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    });
    await aio.close();
  });
});
