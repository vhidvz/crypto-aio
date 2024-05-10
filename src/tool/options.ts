import EventEmitter from 'node:events';

import { bp } from './common';
import { logger } from './logging';
import { AccountOptions, CommonOptions, CryptoOptions, Net } from '../type';

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

export const cryptoOptions = (net: Net, env?: string): CryptoOptions => ({
  ...commonOptions(net, env),
  ...accountOptions(net, env),
});
