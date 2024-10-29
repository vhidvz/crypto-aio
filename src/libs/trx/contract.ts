/* eslint-disable @typescript-eslint/no-unused-vars */

import { TronixOptions } from './index';
import { tronixOptions, initTrx } from '../../tool';
import { Contract, ContractOptions } from '../../type';

export class TronixContract implements Contract<TronixOptions> {
  constructor(readonly options: TronixOptions = tronixOptions()) {
    initTrx(options);
  }

  async estimateGas(
    method: string = 'transfer',
    options: ContractOptions = this.options,
  ): Promise<bigint> {
    throw new Error('unknown client');
  }
}
