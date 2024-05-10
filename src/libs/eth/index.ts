import { ethers } from 'ethers';
import { Web3 } from 'web3';

import { EthereumAccount } from './account';
import { Crypto, CryptoOptions } from '../../type';
import { bp, commonOptions, ethereumOptions, initEth } from '../../tool';

export { EthereumAccount } from './account';
export { EthereumContract } from './contract';
export { EthereumTransact } from './transact';

export interface EthereumOptions extends CryptoOptions {
  lib?: 'web3' | 'ethers';
  client?: Web3 | ethers.Provider;
}

export class Ethereum implements Crypto<EthereumOptions> {
  #account?: EthereumAccount;

  public static readonly symbol = 'ETH';

  constructor(readonly options: EthereumOptions = ethereumOptions()) {
    initEth(options);
  }

  get account(): EthereumAccount {
    return (this.#account = this.#account || new EthereumAccount(this.options));
  }

  createAccount(
    options = commonOptions('ETH'),
    lib = bp<'web3' | 'ethers' | undefined>('ETH', 'LIB'),
  ): EthereumAccount {
    return this.account.create(options, lib);
  }

  async getGasPrice(): Promise<bigint | null> {
    const { client } = this.options;
    if (client instanceof Web3) return client.eth.getGasPrice();
    else if (client instanceof ethers.JsonRpcProvider)
      return (await client.getFeeData()).gasPrice;
    else throw new Error('unknown client');
  }
}
