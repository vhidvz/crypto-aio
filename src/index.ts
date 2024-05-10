import { Ethereum, EthereumOptions } from './libs';
import { ethereumOptions } from './tool';

export * from './libs';
export * from './tool';
export * from './type';

export interface CryptoAioOptions {
  [Ethereum.symbol]?: EthereumOptions;
}

export const cryptoAioOptions = (env?: string): CryptoAioOptions => {
  return {
    ETH: ethereumOptions(env),
  };
};

export class CryptoAio {
  #eth?: Ethereum;

  constructor(readonly options: CryptoAioOptions = cryptoAioOptions()) {}

  get eth(): Ethereum {
    return (this.#eth = this.#eth || new Ethereum(this.options['ETH']));
  }
}
