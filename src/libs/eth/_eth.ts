import { ethers } from 'ethers';
import { Web3 } from 'web3';

import { EthereumAccount } from './account';
import { Crypto, CryptoOptions } from '../../type';
import { defaultEthereumOptions, initEth } from '../../tool';

export interface EthereumOptions extends CryptoOptions {
  lib?: 'web3' | 'ethers';
  client?: Web3 | ethers.Provider;
}

export class Ethereum implements Crypto<EthereumOptions> {
  #account?: EthereumAccount;

  public static readonly symbol = 'ETH';

  constructor(readonly options: EthereumOptions = defaultEthereumOptions()) {
    initEth(options);
  }

  get account(): EthereumAccount {
    return (this.#account = this.#account || new EthereumAccount(this.options));
  }

  async getGasPrice(): Promise<bigint | null> {
    const { client } = this.options;
    if (client instanceof Web3) return client.eth.getGasPrice();
    else if (client instanceof ethers.JsonRpcProvider)
      return (await client.getFeeData()).gasPrice;
    else throw new Error('unknown client');
  }
}
