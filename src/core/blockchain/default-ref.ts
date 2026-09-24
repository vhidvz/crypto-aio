import type { HandleOptions } from '../config/types';
import { ConfigError } from '../errors/error';
import type { Blockchain } from './handle';

let factory: ((config: HandleOptions) => Blockchain) | undefined;

export function setDefaultBlockchainFactory(
  create: (config: HandleOptions) => Blockchain,
): void {
  factory = create;
}

export function defaultBlockchain(config: HandleOptions): Blockchain {
  if (!factory) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'the default container is not initialized; import from the package entry point',
    );
  }
  return factory(config);
}
