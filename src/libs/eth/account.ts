import assert from 'node:assert';
import { ethers } from 'ethers';
import { Web3 } from 'web3';

import {
  bt,
  info,
  initEth,
  defaultCommonOptions,
  defaultEthereumOptions,
} from '../../tool';
import { EthereumOptions } from './index';
import { Account, AccountOptions, CommonOptions } from '../../type';

export class EthereumAccount implements Account<EthereumOptions> {
  constructor(readonly options: EthereumOptions = defaultEthereumOptions()) {
    initEth(options);
  }

  async getBalance(address = this.options.address): Promise<bigint> {
    assert(address, 'address is required');

    const { client } = this.options;
    if (client instanceof Web3) return client.eth.getBalance(address);
    else if (client instanceof ethers.JsonRpcProvider) return client.getBalance(address);
    else throw new Error('unknown client');
  }

  static create(options: CommonOptions = defaultCommonOptions('ETH')): EthereumAccount {
    const wallet = ethers.Wallet.createRandom();
    const account: AccountOptions = {
      address: wallet.address,
      private: wallet.privateKey,
      phrases: wallet.mnemonic?.phrase.split(/ /),
    };

    const { address } = account;
    const { console, emitter } = options;
    if (emitter) emitter.emit(bt('ETH', 'account.create'), account);
    if (console) console(info(`an account created with the ${address} address`));

    return new EthereumAccount({ ...options, ...account });
  }
}
