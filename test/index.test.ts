import { CommonOptions, CryptoAio, CryptoAioOptions, EthereumOptions } from '../src';

describe('test CryptoAio', () => {
  let caio: CryptoAio;

  it('should create an instance', () => {
    caio = new CryptoAio();

    expect(caio).toBeDefined();
    expect(caio.options).toStrictEqual(
      expect.objectContaining<CryptoAioOptions>({
        ETH: expect.objectContaining<CommonOptions>({
          url: expect.any(String),
          console: expect.any(Object),
          emitter: expect.any(Object),
        }),
      }),
    );
  });

  it('should get ethereum instance', () => {
    const { eth } = caio;

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
});
