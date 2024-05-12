import { Transact, TransactOptions } from '../../type';
import { ethereumOptions, initEth } from '../../tool';
import { EthereumOptions } from './index';

export class EthereumTransact implements Transact<EthereumOptions> {
  constructor(readonly options: EthereumOptions = ethereumOptions()) {
    initEth(options);
  }

  async transfer(method?: string, options?: TransactOptions): Promise<bigint> {
    throw new Error('Method not implemented.');
  }
}
