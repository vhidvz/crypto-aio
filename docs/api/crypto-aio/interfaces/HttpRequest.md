[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HttpRequest

# Interface: HttpRequest

Defined in: [src/core/transport/types.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L125)

A REST request to an endpoint, relative to its URL.

## Properties

<a id="body"></a>

### body?

> `readonly` `optional` **body?**: `unknown`

Defined in: [src/core/transport/types.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L131)

Sent as it is when a string, else as JSON.

***

<a id="headers"></a>

### headers?

> `readonly` `optional` **headers?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:132](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L132)

***

<a id="method"></a>

### method

> `readonly` **method**: `"GET"` \| `"POST"`

Defined in: [src/core/transport/types.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L126)

***

<a id="path"></a>

### path

> `readonly` **path**: `string`

Defined in: [src/core/transport/types.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L128)

Appended to the endpoint's URL.

***

<a id="query"></a>

### query?

> `readonly` `optional` **query?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:129](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L129)

***

<a id="responsetype"></a>

### responseType?

> `readonly` `optional` **responseType?**: `"json"` \| `"text"` \| `"bytes"`

Defined in: [src/core/transport/types.ts:139](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L139)

How a 2xx answer is returned (default `'json'`): parsed JSON, the body as text, or its
bytes unchanged as a `Uint8Array` (`'bytes'`, for a binary answer such as a serialized
block, which text decoding would corrupt). Every type is read under
`maxResponseBytes`; an error answer is read as text for its details whatever the type.

***

<a id="route"></a>

### route?

> `readonly` `optional` **route?**: `string`

Defined in: [src/core/transport/types.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L145)

Low-cardinality template label used for event and log method fields instead of the
raw path, e.g. `'/address/:address/utxo'`. Must contain no identifiers (addresses,
hashes, ids). When omitted, events fall back to the bare HTTP method.
