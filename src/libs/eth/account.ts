import assert from 'node:assert';
import { ethers } from 'ethers';
import { Web3 } from 'web3';

import { EthereumOptions } from './index';
import { Account, AccountOptions } from '../../type';
import { bt, bp, info, initEth, commonOptions, ethereumOptions } from '../../tool';

export class EthereumAccount implements Account<EthereumOptions> {
  constructor(readonly options: EthereumOptions = ethereumOptions()) {
    initEth(options);
  }

  async getBalance(address = this.options.address): Promise<bigint> {
    assert(address, 'address is required');

    const { client } = this.options;
    if (client instanceof Web3) return client.eth.getBalance(address);
    else if (client instanceof ethers.JsonRpcProvider) return client.getBalance(address);
    else throw new Error('unknown client');
  }

  create(
    options = commonOptions('ETH'),
    lib = bp<'web3' | 'ethers' | undefined>('ETH', 'LIB'),
  ): EthereumAccount {
    return EthereumAccount.create(options, lib);
  }

  static create(
    options = commonOptions('ETH'),
    lib = bp<'web3' | 'ethers' | undefined>('ETH', 'LIB'),
  ): EthereumAccount {
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

    return new EthereumAccount({ lib, ...options, ...account });
  }
}
