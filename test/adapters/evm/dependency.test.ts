// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('web3', () => {
  throw Object.assign(
    new Error("Cannot find module 'web3' from 'src/adapters/evm/web3-client.ts'"),
    {
      code: 'MODULE_NOT_FOUND',
    },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing EVM SDK', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
    });
    const bc = aio.blockchain({
      chain: 'base',
      network: 'sepolia',
      library: 'web3',
      provider: 'local',
    });
    await expect(bc.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message: expect.stringContaining('npm i web3@^4.16.0'),
      details: { packages: ['web3'] },
    });
    await aio.close();
  });
});
