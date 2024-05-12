import { TronWeb } from 'tronweb';
import assert from 'node:assert';

import { TronixOptions } from './index';
import { Account, AccountOptions } from '../../type';
import { bt, info, initTrx, commonOptions, tronixOptions } from '../../tool';

export class TronixAccount implements Account<TronixOptions> {
  constructor(readonly options: TronixOptions = tronixOptions()) {
    initTrx(options);
  }

  async getBalance(address = this.options.address): Promise<bigint | number> {
    assert(address, 'address is required');

    const { client } = this.options;
    if (client) return client.trx.getBalance(address);
    else throw new Error('unknown client');
  }

  create(options = commonOptions('TRX')): TronixAccount {
    return TronixAccount.create(options);
  }

  static create(options = commonOptions('TRX')): TronixAccount {
    const wallet = TronWeb.createRandom();
    const account: AccountOptions = {
      address: wallet.address,
      private: wallet.privateKey,
      phrases: wallet.mnemonic?.phrase.split(/ /),
    };

    const { address } = account;
    const { console, emitter } = options;
    if (emitter) emitter.emit(bt('TRX', 'account.create'), account);
    if (console) console(info(`an account created with the ${address} address`));

    return new TronixAccount({ ...options, ...account });
  }
}
