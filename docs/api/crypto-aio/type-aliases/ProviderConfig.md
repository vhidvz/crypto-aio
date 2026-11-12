[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ProviderConfig

# Type Alias: ProviderConfig

> **ProviderConfig** = \{ `apiKey?`: `string` \| [`Secret`](../classes/Secret.md)\<`string`\>; `options?`: `Readonly`\<`Record`\<`string`, `unknown`\>\>; `preset`: `string`; \} \| \{ `endpoints`: readonly [`EndpointConfig`](../interfaces/EndpointConfig.md)[]; \}

Defined in: [src/core/config/types.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L19)

A provider: a preset by name with its API key (wrap it in `secret()`) and the preset's
own options, or your own endpoints.
