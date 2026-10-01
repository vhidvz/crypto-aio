/**
 * `crypto-aio/evm`: EVM chains of your own (`evmChainPlugin`), the SDK-free EVM types, and
 * the `crypto-aio/native` client types: importing this entry types `native(bc, 'ethers')`
 * as an ethers `JsonRpcApiProvider` and `native(bc, 'web3')` as a `Web3` instance.
 *
 * @module crypto-aio/evm
 */
import type { JsonRpcApiProvider } from 'ethers';
import type { Web3 } from 'web3';

// Through the package entry, never a core module. SDK types appear only here, in the
// adapter's entry, so the main entry's typings name no SDK.
declare module '../../index' {
  interface NativeClientMap {
    ethers: JsonRpcApiProvider;
    web3: Web3;
  }
}

export { EVM_PEER_DEPENDENCIES, evmChainPlugin } from './plugin';
export type { EvmChainPluginOptions } from './plugin';
export { DEFAULT_MAX_FEE_PER_GAS } from './fees';
export { EVM_CAPABILITIES } from './network';
export type { EvmExt, EvmFeeDetails, EvmFeeOverride } from './types';
