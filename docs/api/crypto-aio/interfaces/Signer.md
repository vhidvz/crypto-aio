[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Signer

# Interface: Signer

Defined in: [src/core/signing/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L60)

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/signing/types.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L61)

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/signing/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L62)

## Methods

<a id="cancelrequest"></a>

### cancelRequest()?

> `optional` **cancelRequest**(`ticket`): `Promise`\<`void`\>

Defined in: [src/core/signing/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L66)

Best-effort cancellation of a pending request (used by `abandon`).

#### Parameters

##### ticket

`string`

#### Returns

`Promise`\<`void`\>

***

<a id="exportkey"></a>

### exportKey()?

> `optional` **exportKey**(`scheme`, `keyRef?`): `Promise`\<[`Secret`](../classes/Secret.md)\<`Uint8Array`\<`ArrayBufferLike`\>\>\>

Defined in: [src/core/signing/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L68)

Only available on signers created as exportable.

#### Parameters

##### scheme

`string`

##### keyRef?

[`KeyRef`](KeyRef.md)

#### Returns

`Promise`\<[`Secret`](../classes/Secret.md)\<`Uint8Array`\<`ArrayBufferLike`\>\>\>

***

<a id="getpublickey"></a>

### getPublicKey()

> **getPublicKey**(`scheme`, `keyRef?`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: [src/core/signing/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L63)

#### Parameters

##### scheme

`string`

##### keyRef?

[`KeyRef`](KeyRef.md)

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

<a id="sign"></a>

### sign()

> **sign**(`requests`, `ctx`): `Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>

Defined in: [src/core/signing/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L64)

#### Parameters

##### requests

readonly [`SigningRequest`](SigningRequest.md)[]

##### ctx

[`SigningContext`](SigningContext.md)

#### Returns

`Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>
