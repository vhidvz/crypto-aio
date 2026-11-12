[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Signer

# Interface: Signer

Defined in: [src/core/signing/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L84)

Holds keys and signs. A port you may implement: it never gains a required member in a
1.x release.

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/signing/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L89)

The signer's own label. The core names a signer by its key in `signers`, which is what
an Operation records (`context.signer`).

***

<a id="schemes"></a>

### schemes

> `readonly` **schemes**: readonly `string`[]

Defined in: [src/core/signing/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L91)

The signature schemes it signs with; a wallet needs each scheme it signs with.

## Methods

<a id="cancelrequest"></a>

### cancelRequest()?

> `optional` **cancelRequest**(`ticket`): `Promise`\<`void`\>

Defined in: [src/core/signing/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L100)

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

Defined in: [src/core/signing/types.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L102)

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

Defined in: [src/core/signing/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L93)

The public key it signs with under `scheme`, for `keyRef`.

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

Defined in: [src/core/signing/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L98)

Signs every request, or answers `pending` with a ticket. Check `ctx` against your
policy here or in `beforeSign`; the core verifies each signature it gets back.

#### Parameters

##### requests

readonly [`SigningRequest`](SigningRequest.md)[]

##### ctx

[`SigningContext`](SigningContext.md)

#### Returns

`Promise`\<[`SigningResult`](../type-aliases/SigningResult.md)\>
