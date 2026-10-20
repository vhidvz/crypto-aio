[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HttpRequest

# Interface: HttpRequest

Defined in: [src/core/transport/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L84)

## Properties

<a id="body"></a>

### body?

> `readonly` `optional` **body?**: `unknown`

Defined in: [src/core/transport/types.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L88)

***

<a id="headers"></a>

### headers?

> `readonly` `optional` **headers?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L89)

***

<a id="method"></a>

### method

> `readonly` **method**: `"GET"` \| `"POST"`

Defined in: [src/core/transport/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L85)

***

<a id="path"></a>

### path

> `readonly` **path**: `string`

Defined in: [src/core/transport/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L86)

***

<a id="query"></a>

### query?

> `readonly` `optional` **query?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L87)

***

<a id="responsetype"></a>

### responseType?

> `readonly` `optional` **responseType?**: `"json"` \| `"text"` \| `"bytes"`

Defined in: [src/core/transport/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L96)

How a 2xx answer is returned (default `'json'`): parsed JSON, the body as text, or its
bytes unchanged as a `Uint8Array` (`'bytes'`, for a binary answer such as a serialized
block, which text decoding would corrupt). Every type is read under
`maxResponseBytes`; an error answer is read as text for its details whatever the type.

***

<a id="route"></a>

### route?

> `readonly` `optional` **route?**: `string`

Defined in: [src/core/transport/types.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L102)

Low-cardinality template label used for event and log method fields instead of the
raw path, e.g. `'/address/:address/utxo'`. Must contain no identifiers (addresses,
hashes, ids). When omitted, events fall back to the bare HTTP method.
