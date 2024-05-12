import assert from 'node:assert';

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
    const { abi, contract: address } = options;
    assert(abi?.length && address, 'abi and contract are required');

    const { client } = this.options;
    if (client) {
      return client.trx.estimateGas({ from: address, type: method });
    } else throw new Error('unknown client');
  }
}
