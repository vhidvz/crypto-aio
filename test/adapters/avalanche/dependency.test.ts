// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('@avalabs/avalanchejs', () => {
  throw Object.assign(
    new Error(
      "Cannot find module '@avalabs/avalanchejs' from 'src/adapters/avalanche/sdk.ts'",
    ),
    { code: 'MODULE_NOT_FOUND' },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing @avalabs/avalanchejs', () => {
  it.each(['avalanche-x', 'avalanche-p'] as const)(
    '%s fails with DEPENDENCY_MISSING and the exact install command',
    async (chain) => {
      const aio = new CryptoAio({
        env: false,
        providers: {
          node: { endpoints: [{ url: 'https://node.invalid/ext/bc/X' }] },
          data: { endpoints: [{ url: 'https://data.invalid', kind: 'indexer' }] },
        },
      });
      const bc = aio.blockchain({ chain, provider: 'node', indexer: 'data' });
      await expect(bc.ready()).rejects.toMatchObject({
        name: 'ConfigError',
        code: 'DEPENDENCY_MISSING',
        message:
          "library '@avalabs/avalanchejs' (avalanche) needs @avalabs/avalanchejs; install it: npm i @avalabs/avalanchejs@^5.2.0",
        details: { packages: ['@avalabs/avalanchejs'] },
        cause: expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
      });
      await aio.close();
    },
  );
});
