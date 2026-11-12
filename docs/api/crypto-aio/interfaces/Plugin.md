[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Plugin

# Interface: Plugin

Defined in: [src/core/registry/plugin.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L15)

Everything a chain family contributes. Plugin modules must not import SDKs. Registering
the same plugin again is a no-op; another plugin under a registered name is
`CONFIG_INVALID`.

## Properties

<a id="adapters"></a>

### adapters?

> `readonly` `optional` **adapters?**: readonly [`AdapterManifest`](AdapterManifest.md)[]

Defined in: [src/core/registry/plugin.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L19)

***

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](AssetRegistration.md)[]

Defined in: [src/core/registry/plugin.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L21)

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: readonly [`ChainInfo`](ChainInfo.md)[]

Defined in: [src/core/registry/plugin.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L18)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/registry/plugin.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L17)

Unique among the plugins of a container.

***

<a id="presets"></a>

### presets?

> `readonly` `optional` **presets?**: readonly [`ProviderPreset`](ProviderPreset.md)[]

Defined in: [src/core/registry/plugin.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L20)

***

<a id="schemes"></a>

### schemes?

> `readonly` `optional` **schemes?**: readonly [`SignatureScheme`](SignatureScheme.md)[]

Defined in: [src/core/registry/plugin.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L22)
