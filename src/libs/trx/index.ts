import { TronWeb } from 'tronweb';

import { TronixAccount } from './account';
import { TronixContract } from './contract';
import { TronixTransact } from './transact';
import { Crypto, CryptoOptions } from '../../type';
import { commonOptions, tronixOptions, initTrx } from '../../tool';

export { TronixAccount } from './account';
export { TronixContract } from './contract';
export { TronixTransact } from './transact';

export interface TronixOptions extends CryptoOptions {
  client?: TronWeb;
}

export class Tronix implements Crypto<TronixOptions> {
  #account?: TronixAccount;
  #contract?: TronixContract;
  #transact?: TronixTransact;

  public static readonly symbol = 'TRX';

  constructor(readonly options: TronixOptions = tronixOptions()) {
    initTrx(options);
  }

  get account(): TronixAccount {
    return (this.#account = this.#account || new TronixAccount(this.options));
  }

  get contract(): TronixContract {
    return (this.#contract = this.#contract || new TronixContract(this.options));
  }

  get transact(): TronixTransact {
    return (this.#transact = this.#transact || new TronixTransact(this.options));
  }

  createAccount(options = commonOptions('TRX')): TronixAccount {
    return this.account.create(options);
  }

  async getGasPrice(): Promise<bigint | null> {
    throw new Error('unknown client');
  }
}
