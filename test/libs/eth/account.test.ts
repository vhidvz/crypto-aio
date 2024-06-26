import { EthereumAccount, EthereumOptions } from '../../../src';

describe('test ethereum account', () => {
  let account: EthereumAccount;

  it('should create an instance', () => {
    account = EthereumAccount.create();

    expect(account).toBeDefined();
    expect(account.options).toStrictEqual(
      expect.objectContaining<EthereumOptions>({
        client: expect.anything(),
        address: expect.any(String),
        private: expect.any(String),
        phrases: expect.any(Array<string>),
      }),
    );
  });

  it('should return getBalance', async () => {
    const balance = await account.getBalance();

    expect(balance).toBeDefined();
    expect(String(balance)).toMatch(/\d+/);
  });
});
