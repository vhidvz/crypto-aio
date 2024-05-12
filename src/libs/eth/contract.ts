import assert from 'node:assert';
import { ethers } from 'ethers';
import { Web3 } from 'web3';

import { EthereumOptions } from './index';
import { ethereumOptions, initEth } from '../../tool';
import { Contract, ContractOptions } from '../../type';

export class EthereumContract implements Contract<EthereumOptions> {
  constructor(readonly options: EthereumOptions = ethereumOptions()) {
    initEth(options);
  }

  async estimateGas(
    method: string = 'transfer',
    options: ContractOptions = this.options,
  ): Promise<bigint> {
    const { abi, contract: address } = options;
    assert(abi?.length && address, 'abi and contract are required');

    const { client } = this.options;
    if (client instanceof Web3) {
      return client.eth.estimateGas({ from: address, type: method });
    } else if (client instanceof ethers.JsonRpcProvider) {
      return client.estimateGas({ from: address, value: method });
    } else throw new Error('unknown client');
  }
}
