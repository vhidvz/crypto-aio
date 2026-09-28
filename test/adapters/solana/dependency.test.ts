// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('@solana/web3.js', () => {
  throw Object.assign(
    new Error("Cannot find module '@solana/web3.js' from 'src/adapters/solana/web3.ts'"),
    { code: 'MODULE_NOT_FOUND' },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing Solana SDK', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
    });
    const bc = aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'local' });
    await expect(bc.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message: expect.stringContaining('npm i @solana/web3.js@^1.99.0'),
      details: { packages: ['@solana/web3.js'] },
    });
    await aio.close();
  });
});
