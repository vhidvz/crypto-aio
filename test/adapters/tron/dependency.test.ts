// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('tronweb', () => {
  throw Object.assign(
    new Error("Cannot find module 'tronweb' from 'src/adapters/tron/codec.ts'"),
    {
      code: 'MODULE_NOT_FOUND',
    },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing tronweb', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: { local: { endpoints: [{ url: 'https://node.invalid' }] } },
    });
    const bc = aio.blockchain({ chain: 'tron', network: 'nile', provider: 'local' });
    await expect(bc.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message: expect.stringContaining('npm i tronweb@^6.5.1'),
      details: { packages: ['tronweb'] },
    });
    await aio.close();
  });
});
