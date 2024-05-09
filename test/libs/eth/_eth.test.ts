import { Ethereum, EthereumOptions } from '../../../src';

describe('test lib Ethereum', () => {
  let eth: Ethereum;

  it('should create an instance', () => {
    eth = new Ethereum();

    expect(eth).toBeDefined();
    expect(eth.options).toStrictEqual(
      expect.objectContaining<EthereumOptions>({
        client: expect.any(Object),
        address: expect.any(String),
        private: expect.any(String),
        phrases: expect.any(Array<string>),
      }),
    );
  });

  it('should return getGasPrice', async () => {
    const gasPrice = await eth.getGasPrice();

    expect(gasPrice).toBeDefined();
    expect(String(gasPrice)).toMatch(/\d+/);
  });
});
