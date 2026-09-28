// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('bitcoinjs-lib', () => {
  throw Object.assign(
    new Error("Cannot find module 'bitcoinjs-lib' from 'src/adapters/utxo/sdk.ts'"),
    { code: 'MODULE_NOT_FOUND' },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing bitcoinjs-lib', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: { local: { endpoints: [{ url: 'https://esplora.invalid/api' }] } },
    });
    const bc = aio.blockchain({ chain: 'bitcoin', provider: 'local', indexer: 'local' });
    await expect(bc.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message:
        "library 'bitcoinjs-lib' (utxo) needs bitcoinjs-lib; install it: npm i bitcoinjs-lib@^7.0.2",
      details: { packages: ['bitcoinjs-lib'] },
      cause: expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    });
    await aio.close();
  });
});
