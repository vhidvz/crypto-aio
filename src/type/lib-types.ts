import { CommonOptions } from './common';
import { AccountOptions } from './account';
import { ContractOptions } from './contract';

export type CryptoOptions = CommonOptions & AccountOptions & ContractOptions;

export interface Crypto<Options extends CryptoOptions> {
  readonly options: Options;

  getGasPrice(): Promise<bigint | null>;
}
