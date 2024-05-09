import { Net } from '../type';

/**
 * The function an env on the provided network, postfix, and environment variables.
 *
 * @param {Net} net - The `net` parameter is a variable representing the network.
 * @param {string} postfix - The `postfix` parameter is a string that will be appended to the base
 * topic before returning the final topic string.
 * @param {string | undefined} env - The `env` parameter is a string that represents the environment in
 * which the topic is being generated. It is optional and defaults to the value of the `CRYPTO_AIO_ENV`
 * environment variable from the process environment.
 *
 * @returns The function returns a string that is formatted as `CRYPTO_AIO_[${env}_]${net}_${postfix}
 */
export const bp = <T = string>(
  net: Net,
  postfix: string,
  env: string | undefined = process.env['CRYPTO_AIO_ENV'],
): T =>
  process.env[`CRYPTO_AIO_${env ? env.toUpperCase() + '_' : ''}${net}_${postfix}`] as T;

/**
 * The function generates a topic string based on the provided network, postfix, and
 * optional environment variables.
 *
 * @param {Net} net - The `net` parameter is a variable representing the network.
 * @param {string} postfix - The `postfix` parameter is a string that will be appended to the base
 * topic before returning the final topic string.
 * @param {string | undefined} env - The `env` parameter is a string that represents the environment in
 * which the topic is being generated. It is optional and defaults to the value of the `CRYPTO_AIO_ENV`
 * environment variable from the process environment.
 *
 * @returns The function returns a string that is formatted as `crypto-aio.[${env}.]${net}.${postfix}
 */
export const bt = (
  net: Net,
  postfix: string,
  env: string | undefined = process.env['CRYPTO_AIO_ENV'],
): string =>
  `crypto-aio.${env ? env.toLowerCase() + '.' : ''}${net.toLowerCase()}.${postfix}`;
