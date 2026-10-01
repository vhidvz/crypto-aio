[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SerializedError

# Interface: SerializedError

Defined in: [src/core/errors/error.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L16)

## Properties

<a id="ambiguous"></a>

### ambiguous

> `readonly` **ambiguous**: `boolean`

Defined in: [src/core/errors/error.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L22)

***

<a id="category"></a>

### category

> `readonly` **category**: [`ErrorCategory`](../type-aliases/ErrorCategory.md)

Defined in: [src/core/errors/error.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L19)

***

<a id="code"></a>

### code

> `readonly` **code**: `"CONFIG_INVALID"` \| `"DEPENDENCY_MISSING"` \| `"INCOMPATIBLE_SELECTION"` \| `"UNSUPPORTED_CAPABILITY"` \| `"INVALID_ADDRESS"` \| `"INVALID_AMOUNT"` \| `"ASSET_RESOLUTION"` \| `"INVALID_INTENT"` \| `"PROVIDER_UNAVAILABLE"` \| `"RATE_LIMITED"` \| `"PROVIDER_MISCONFIGURED"` \| `"PROVIDER_INCONSISTENT"` \| `"RPC_ERROR"` \| `"INSUFFICIENT_FUNDS"` \| `"NONCE_CONFLICT"` \| `"NONCE_TOO_HIGH"` \| `"FEE_TOO_LOW"` \| `"TX_REFUSED"` \| `"TX_REJECTED"` \| `"TX_REVERTED"` \| `"TX_EXPIRED"` \| `"TX_REPLACED"` \| `"SIGNER_UNAVAILABLE"` \| `"SIGNING_FAILED"` \| `"SIGNATURE_MISMATCH"` \| `"POLICY_REJECTED"` \| `"KEY_NOT_EXPORTABLE"` \| `"IDEMPOTENCY_CONFLICT"` \| `"FENCING"` \| `"VERSION_CONFLICT"` \| `"INVALID_TRANSITION"` \| `"NOT_FOUND"` \| `"SEQUENCE_BUSY"` \| `"STATE_UNRECORDED"` \| `"SCANNER_REORG_TOO_DEEP"` \| `"TIMEOUT"`

Defined in: [src/core/errors/error.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L18)

***

<a id="context"></a>

### context

> `readonly` **context**: [`ErrorContext`](../type-aliases/ErrorContext.md)

Defined in: [src/core/errors/error.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L23)

***

<a id="details"></a>

### details?

> `readonly` `optional` **details?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/errors/error.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L24)

***

<a id="message"></a>

### message

> `readonly` **message**: `string`

Defined in: [src/core/errors/error.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L20)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/errors/error.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L17)

***

<a id="retryable"></a>

### retryable

> `readonly` **retryable**: `boolean`

Defined in: [src/core/errors/error.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L21)
