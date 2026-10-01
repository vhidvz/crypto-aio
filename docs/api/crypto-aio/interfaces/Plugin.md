[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Plugin

# Interface: Plugin

Defined in: [src/core/registry/plugin.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L11)

Everything a chain family contributes. Plugin modules must not import SDKs.

## Properties

<a id="adapters"></a>

### adapters?

> `readonly` `optional` **adapters?**: readonly [`AdapterManifest`](AdapterManifest.md)[]

Defined in: [src/core/registry/plugin.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L14)

***

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](AssetRegistration.md)[]

Defined in: [src/core/registry/plugin.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L16)

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: readonly [`ChainInfo`](ChainInfo.md)[]

Defined in: [src/core/registry/plugin.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L13)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/registry/plugin.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L12)

***

<a id="presets"></a>

### presets?

> `readonly` `optional` **presets?**: readonly [`ProviderPreset`](ProviderPreset.md)[]

Defined in: [src/core/registry/plugin.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L15)

***

<a id="schemes"></a>

### schemes?

> `readonly` `optional` **schemes?**: readonly [`SignatureScheme`](SignatureScheme.md)[]

Defined in: [src/core/registry/plugin.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/plugin.ts#L17)
