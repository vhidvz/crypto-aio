[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ProviderPreset

# Interface: ProviderPreset

Defined in: [src/core/registry/providers.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L15)

Provider preset contributed by a family plugin. Endpoint URLs holding keys must be `Secret`s.

## Properties

<a id="kind"></a>

### kind

> `readonly` **kind**: `"rpc"` \| `"indexer"`

Defined in: [src/core/registry/providers.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L18)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/registry/providers.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L17)

The name a `ProviderConfig` uses (`{ preset: name }`).

***

<a id="production"></a>

### production?

> `readonly` `optional` **production?**: `boolean`

Defined in: [src/core/registry/providers.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L22)

`false` for free public endpoints (logged as not for production).

***

<a id="requiresapikey"></a>

### requiresApiKey?

> `readonly` `optional` **requiresApiKey?**: `boolean`

Defined in: [src/core/registry/providers.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L20)

Whether a provider without an `apiKey` is refused.

## Methods

<a id="endpoints"></a>

### endpoints()

> **endpoints**(`input`): readonly [`EndpointConfig`](EndpointConfig.md)[]

Defined in: [src/core/registry/providers.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L26)

The endpoints for `input`.

#### Parameters

##### input

[`PresetInput`](PresetInput.md)

#### Returns

readonly [`EndpointConfig`](EndpointConfig.md)[]

***

<a id="supports"></a>

### supports()

> **supports**(`chain`, `network`): `boolean`

Defined in: [src/core/registry/providers.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L24)

Whether it serves `chain`'s `network`.

#### Parameters

##### chain

`string`

##### network

`string`

#### Returns

`boolean`
