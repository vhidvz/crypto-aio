import EventEmitter from 'node:events';

import { logger } from '../tool';
import { Ethereum } from '../libs';

export type Net = typeof Ethereum.symbol;

export type EmitterOptions = {
  emitter?: EventEmitter;
};

export type LoggerOptions = {
  console?: ReturnType<typeof logger>;
};

export type ProviderOptions = { url?: string };

export type CommonOptions = ProviderOptions & EmitterOptions & LoggerOptions;
