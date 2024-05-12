import { Transact, TransactOptions } from '../../type';
import { tronixOptions, initTrx } from '../../tool';
import { TronixOptions } from './index';

export class TronixTransact implements Transact<TronixOptions> {
  constructor(readonly options: TronixOptions = tronixOptions()) {
    initTrx(options);
  }

  async transfer(method?: string, options?: TransactOptions): Promise<bigint> {
    throw new Error('Method not implemented.');
  }
}
