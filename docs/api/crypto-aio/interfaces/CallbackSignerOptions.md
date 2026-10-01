[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CallbackSignerOptions

# Interface: CallbackSignerOptions

Defined in: [src/core/signing/callback.ts:4](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L4)

## Properties

<a id="cancelrequest"></a>

### cancelRequest?

> `readonly` `optional` **cancelRequest?**: (`ticket`) => `Promise`\<`void`\>

Defined in: [src/core/signing/callback.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L9)

#### Parameters

##### ticket

`string`

#### Returns

`Promise`\<`void`\>

***

<a id="getpublickey"></a>

### getPublicKey

> `readonly` **getPublicKey**: (`scheme`, `keyRef?`) => `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: [src/core/signing/callback.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L7)

#### Parameters

##### scheme

`string`

##### keyRef?

[`KeyRef`](KeyRef.md)

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/signing/callback.ts:5](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L5)

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/signing/callback.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L6)

***

<a id="sign"></a>

### sign

> `readonly` **sign**: (`requests`, `ctx`) => `Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>

Defined in: [src/core/signing/callback.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L8)

#### Parameters

##### requests

readonly [`SigningRequest`](SigningRequest.md)[]

##### ctx

[`SigningContext`](SigningContext.md)

#### Returns

`Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>
