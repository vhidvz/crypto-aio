import EventEmitter from 'node:events';

import { bp } from './common';
import { logger } from './logging';
import { AccountOptions, CommonOptions, CryptoOptions, Net } from '../type';

export const defaultCommonOptions = (net: Net, env?: string): CommonOptions => {
  return {
    url: bp(net, 'URL', env),
    emitter: new EventEmitter(),
    console: logger(net.toLowerCase()),
  };
};

export const defaultAccountOptions = (net: Net, env?: string): AccountOptions => {
  return {
    address: bp(net, 'ADDRESS', env),
    private: bp(net, 'PRIVATE', env),
    phrases: bp(net, 'PHRASES', env).split(/,/),
  };
};

export const defaultCryptoOptions = (net: Net, env?: string): CryptoOptions => {
  return { ...defaultAccountOptions(net, env), ...defaultCommonOptions(net, env) };
};
