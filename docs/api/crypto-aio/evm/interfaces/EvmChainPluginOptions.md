[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / EvmChainPluginOptions

# Interface: EvmChainPluginOptions

Defined in: [src/adapters/evm/plugin.ts:137](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L137)

`evmChainPlugin()`'s options: one EVM chain to register, with its networks and tokens.

## Properties

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](../../interfaces/AssetRegistration.md)[]

Defined in: [src/adapters/evm/plugin.ts:151](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L151)

Tokens: `erc20` refs, each registered under its EIP-55 checksummed contract, whatever
case it is given in, so its alias and its transfers name one asset id.

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly [`ChainInfo`](../../interfaces/ChainInfo.md)[]

Defined in: [src/adapters/evm/plugin.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L145)

Chains with `family: 'evm'`, nonce ordering and the `secp256k1-ecdsa` scheme.

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/adapters/evm/plugin.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L143)

A unique name matching `/^[a-z][a-z0-9-]*$/`. The plugin registers as `evm:<name>`, so
it never collides with a family plugin, and its manifests as `evm:<name>/ethers` and
`evm:<name>/web3`.

***

<a id="presets"></a>

### presets?

> `readonly` `optional` **presets?**: readonly [`ProviderPreset`](../../interfaces/ProviderPreset.md)[]

Defined in: [src/adapters/evm/plugin.ts:146](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L146)
