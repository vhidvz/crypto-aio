import { debug } from 'debug';

export const warn = (msg: string) => `\x1b[33m[WARN] ${msg}\x1b[0m`;
export const info = (msg: string) => `\x1b[34m[INFO] ${msg}\x1b[0m`;

export const logger = (namespace: string) => debug('crypto-aio').extend(namespace);
