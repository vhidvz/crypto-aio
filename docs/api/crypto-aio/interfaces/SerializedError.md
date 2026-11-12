[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SerializedError

# Interface: SerializedError

Defined in: [src/core/errors/error.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L22)

An error as JSON (`toJSON()`), as an Operation stores it.

## Properties

<a id="ambiguous"></a>

### ambiguous

> `readonly` **ambiguous**: `boolean`

Defined in: [src/core/errors/error.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L28)

***

<a id="category"></a>

### category

> `readonly` **category**: [`ErrorCategory`](../type-aliases/ErrorCategory.md)

Defined in: [src/core/errors/error.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L25)

***

<a id="code"></a>

### code

> `readonly` **code**: `"CONFIG_INVALID"` \| `"DEPENDENCY_MISSING"` \| `"INCOMPATIBLE_SELECTION"` \| `"UNSUPPORTED_CAPABILITY"` \| `"INVALID_ADDRESS"` \| `"INVALID_AMOUNT"` \| `"ASSET_RESOLUTION"` \| `"INVALID_INTENT"` \| `"PROVIDER_UNAVAILABLE"` \| `"RATE_LIMITED"` \| `"PROVIDER_MISCONFIGURED"` \| `"PROVIDER_INCONSISTENT"` \| `"RPC_ERROR"` \| `"INSUFFICIENT_FUNDS"` \| `"NONCE_CONFLICT"` \| `"NONCE_TOO_HIGH"` \| `"FEE_TOO_LOW"` \| `"TX_REFUSED"` \| `"TX_REJECTED"` \| `"TX_REVERTED"` \| `"TX_UNEVIDENCED"` \| `"TX_EXPIRED"` \| `"TX_REPLACED"` \| `"SIGNER_UNAVAILABLE"` \| `"SIGNING_FAILED"` \| `"SIGNATURE_MISMATCH"` \| `"POLICY_REJECTED"` \| `"KEY_NOT_EXPORTABLE"` \| `"IDEMPOTENCY_CONFLICT"` \| `"FENCING"` \| `"VERSION_CONFLICT"` \| `"INVALID_TRANSITION"` \| `"NOT_FOUND"` \| `"SEQUENCE_BUSY"` \| `"STATE_UNRECORDED"` \| `"SCANNER_REORG_TOO_DEEP"` \| `"RECORD_FORMAT_UNSUPPORTED"` \| `"TIMEOUT"`

Defined in: [src/core/errors/error.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L24)

***

<a id="context"></a>

### context

> `readonly` **context**: [`ErrorContext`](../type-aliases/ErrorContext.md)

Defined in: [src/core/errors/error.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L29)

***

<a id="details"></a>

### details?

> `readonly` `optional` **details?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/errors/error.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L30)

***

<a id="message"></a>

### message

> `readonly` **message**: `string`

Defined in: [src/core/errors/error.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L26)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/errors/error.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L23)

***

<a id="retryable"></a>

### retryable

> `readonly` **retryable**: `boolean`

Defined in: [src/core/errors/error.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L27)
