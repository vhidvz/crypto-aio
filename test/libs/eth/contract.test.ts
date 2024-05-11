import { EthereumContract, EthereumOptions } from '../../../src';

describe('test ethereum contract', () => {
  let contract: EthereumContract;

  it('should create an instance', () => {
    contract = new EthereumContract();

    expect(contract).toBeDefined();
    expect(contract.options).toStrictEqual(
      expect.objectContaining<EthereumOptions>({
        abi: expect.anything(),
        contract: expect.any(String),
      }),
    );
  });

  it('should return estimateGas', async () => {
    const gasLimit = await contract.estimateGas();

    expect(gasLimit).toBeDefined();
    expect(String(gasLimit)).toMatch(/\d+/);
  });
});
