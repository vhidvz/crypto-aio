[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / EvmChainPluginOptions

# Interface: EvmChainPluginOptions

Defined in: [src/adapters/evm/plugin.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L87)

## Properties

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](../../interfaces/AssetRegistration.md)[]

Defined in: [src/adapters/evm/plugin.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L97)

***

<a id="chains"></a>

### chains

> `readonly` **chains**: readonly [`ChainInfo`](../../interfaces/ChainInfo.md)[]

Defined in: [src/adapters/evm/plugin.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L95)

Chains with `family: 'evm'`, nonce ordering and the `secp256k1-ecdsa` scheme.

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/adapters/evm/plugin.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L93)

A unique name matching `/^[a-z][a-z0-9-]*$/`. The plugin registers as `evm:<name>`, so
it never collides with a family plugin, and its manifests as `evm:<name>/ethers` and
`evm:<name>/web3`.

***

<a id="presets"></a>

### presets?

> `readonly` `optional` **presets?**: readonly [`ProviderPreset`](../../interfaces/ProviderPreset.md)[]

Defined in: [src/adapters/evm/plugin.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/plugin.ts#L96)
