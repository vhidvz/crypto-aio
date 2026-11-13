[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CallbackSignerOptions

# Interface: CallbackSignerOptions

Defined in: [src/core/signing/callback.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L9)

`callbackSigner()`'s options: the signer's `id`, the schemes its key signs with (every
scheme a wallet needs must be listed), and the callbacks that reach your custody system.
`cancelRequest`, when given, is called with a pending request's ticket on `abandon`.

## Properties

<a id="cancelrequest"></a>

### cancelRequest?

> `readonly` `optional` **cancelRequest?**: (`ticket`) => `Promise`\<`void`\>

Defined in: [src/core/signing/callback.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L14)

#### Parameters

##### ticket

`string`

#### Returns

`Promise`\<`void`\>

***

<a id="getpublickey"></a>

### getPublicKey

> `readonly` **getPublicKey**: (`scheme`, `keyRef?`) => `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: [src/core/signing/callback.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L12)

The public key it signs with under `scheme`, for `keyRef`.

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

Defined in: [src/core/signing/callback.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L10)

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/signing/callback.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L11)

***

<a id="sign"></a>

### sign

> `readonly` **sign**: (`requests`, `ctx`) => `Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>

Defined in: [src/core/signing/callback.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/callback.ts#L13)

Signs every request, or answers `pending` with a ticket. Check `ctx` against your
policy here or in `beforeSign`; the core verifies each signature it gets back.

#### Parameters

##### requests

readonly [`SigningRequest`](SigningRequest.md)[]

##### ctx

[`SigningContext`](SigningContext.md)

#### Returns

`Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>
