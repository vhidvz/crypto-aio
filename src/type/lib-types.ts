import { CommonOptions } from './common';
import { AccountOptions } from './account';
import { ContractOptions } from './contract';
import { TransactOptions } from './transact';

export type CryptoOptions = CommonOptions &
  AccountOptions &
  ContractOptions &
  TransactOptions;

export interface Crypto<Options extends CryptoOptions> {
  readonly options: Options;

  getGasPrice(): Promise<bigint | null>;
}
