import { AccountOptions } from './account';
import { CommonOptions } from './common';

export type CryptoOptions = CommonOptions & AccountOptions;

export interface Crypto<Options extends CryptoOptions> {
  readonly options: Options;

  getGasPrice(): Promise<bigint | null>;
}
