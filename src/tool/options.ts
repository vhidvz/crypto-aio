import EventEmitter from 'node:events';

import {
  Net,
  CryptoOptions,
  CommonOptions,
  AccountOptions,
  ContractOptions,
} from '../type';
import { bp } from './common';
import { logger } from './logging';

export const commonOptions = (net: Net, env?: string): CommonOptions => ({
  url: bp(net, 'URL', env),
  emitter: new EventEmitter(),
  console: logger(net.toLowerCase()),
  env: process.env.CRYPTO_AIO_ENV?.toLowerCase(),
});

export const accountOptions = (net: Net, env?: string): AccountOptions => ({
  address: bp(net, 'ADDRESS', env),
  private: bp(net, 'PRIVATE', env),
  phrases: bp(net, 'PHRASES', env).split(/,/),
});

export const contractOptions = (net: Net, env?: string): ContractOptions => ({
  contract: bp(net, 'CONTRACT', env),
  abi: JSON.parse(bp(net, 'ABI', env) || '[]'),
});

export const transactOptions = (net: Net, env?: string): ContractOptions => ({
  contract: bp(net, 'CONTRACT', env),
  abi: JSON.parse(bp(net, 'ABI', env) || '[]'),
});

export const cryptoOptions = (net: Net, env?: string): CryptoOptions => ({
  ...commonOptions(net, env),
  ...accountOptions(net, env),
  ...contractOptions(net, env),
  ...transactOptions(net, env),
});
