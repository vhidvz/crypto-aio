[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HttpRequest

# Interface: HttpRequest

Defined in: [src/core/transport/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L75)

## Properties

<a id="body"></a>

### body?

> `readonly` `optional` **body?**: `unknown`

Defined in: [src/core/transport/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L79)

***

<a id="headers"></a>

### headers?

> `readonly` `optional` **headers?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L80)

***

<a id="method"></a>

### method

> `readonly` **method**: `"GET"` \| `"POST"`

Defined in: [src/core/transport/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L76)

***

<a id="path"></a>

### path

> `readonly` **path**: `string`

Defined in: [src/core/transport/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L77)

***

<a id="query"></a>

### query?

> `readonly` `optional` **query?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Defined in: [src/core/transport/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L78)

***

<a id="responsetype"></a>

### responseType?

> `readonly` `optional` **responseType?**: `"json"` \| `"text"`

Defined in: [src/core/transport/types.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L81)

***

<a id="route"></a>

### route?

> `readonly` `optional` **route?**: `string`

Defined in: [src/core/transport/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L87)

Low-cardinality template label used for event and log method fields instead of the
raw path, e.g. `'/address/:address/utxo'`. Must contain no identifiers (addresses,
hashes, ids). When omitted, events fall back to the bare HTTP method.
