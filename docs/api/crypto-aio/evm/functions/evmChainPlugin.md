[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / evmChainPlugin

# Function: evmChainPlugin()

> **evmChainPlugin**(`options`): [`Plugin`](../../interfaces/Plugin.md)

Defined in: [src/adapters/evm/plugin.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L157)

A plugin for EVM chains of your own, served by the built-in EVM driver with either
library. Every network and token is validated here, so bad data fails at registration.

## Parameters

### options

[`EvmChainPluginOptions`](../interfaces/EvmChainPluginOptions.md)

## Returns

[`Plugin`](../../interfaces/Plugin.md)
