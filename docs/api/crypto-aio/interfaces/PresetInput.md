[crypto-aio](../../index.md) / [crypto-aio](../index.md) / PresetInput

# Interface: PresetInput

Defined in: [src/core/registry/providers.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L7)

What a preset builds its endpoints from: the network, and the provider's key and options.

## Properties

<a id="apikey"></a>

### apiKey?

> `readonly` `optional` **apiKey?**: `string` \| [`Secret`](../classes/Secret.md)\<`string`\>

Defined in: [src/core/registry/providers.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L10)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/registry/providers.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L8)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/registry/providers.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L9)

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/registry/providers.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L11)
