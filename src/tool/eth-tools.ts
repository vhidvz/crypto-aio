import assert from 'node:assert';
import { ethers } from 'ethers';
import { Web3 } from 'web3';

import { bp } from './common';
import { warn } from './logging';
import { EthereumOptions } from '../libs';
import { defaultCryptoOptions } from './options';

export const defaultEthereumOptions = (env?: string): EthereumOptions =>
  defaultCryptoOptions('ETH', env);

export const initEth = (options: EthereumOptions = defaultEthereumOptions()) => {
  const { client, url, lib } = options;
  if (!client) {
    assert(url, 'client or url option is required');
    options.lib = lib || bp('ETH', 'LIB') || 'ethers';

    if (lib === 'web3') options.client = new Web3(url);
    else if (lib === 'ethers') options.client = new ethers.JsonRpcProvider(url);
    else {
      options.client = new Web3(url);

      const { console } = options;
      if (console) console(warn('Unknown lib, Web3 used by default'));
    }
  }
};
