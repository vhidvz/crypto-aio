import { TronWeb } from 'tronweb';
import assert from 'node:assert';

import { TronixOptions } from '../libs';
import { cryptoOptions } from './options';

export const tronixOptions = (env?: string): TronixOptions => ({
  ...cryptoOptions('TRX', env),
});

export const initTrx = (options: TronixOptions = tronixOptions()) => {
  const { client, url } = options;
  if (!client) {
    assert(url, 'client or url option is required');
    options.client = new TronWeb({ fullHost: url });
  }
};
