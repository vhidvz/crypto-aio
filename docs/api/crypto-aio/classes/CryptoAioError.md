[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CryptoAioError

# Class: CryptoAioError

Defined in: [src/core/errors/error.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L27)

## Extends

- `Error`

## Extended by

- [`ChainError`](ChainError.md)
- [`ConfigError`](ConfigError.md)
- [`ProviderError`](ProviderError.md)
- [`SigningError`](SigningError.md)
- [`StateError`](StateError.md)
- [`TimeoutError`](TimeoutError.md)
- [`UnsupportedCapabilityError`](UnsupportedCapabilityError.md)
- [`ValidationError`](ValidationError.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new CryptoAioError**(`code`, `message`, `options?`): `CryptoAioError`

Defined in: [src/core/errors/error.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L35)

#### Parameters

##### code

`"CONFIG_INVALID"` \| `"DEPENDENCY_MISSING"` \| `"INCOMPATIBLE_SELECTION"` \| `"UNSUPPORTED_CAPABILITY"` \| `"INVALID_ADDRESS"` \| `"INVALID_AMOUNT"` \| `"ASSET_RESOLUTION"` \| `"INVALID_INTENT"` \| `"PROVIDER_UNAVAILABLE"` \| `"RATE_LIMITED"` \| `"PROVIDER_MISCONFIGURED"` \| `"PROVIDER_INCONSISTENT"` \| `"RPC_ERROR"` \| `"INSUFFICIENT_FUNDS"` \| `"NONCE_CONFLICT"` \| `"NONCE_TOO_HIGH"` \| `"FEE_TOO_LOW"` \| `"TX_REFUSED"` \| `"TX_REJECTED"` \| `"TX_REVERTED"` \| `"TX_EXPIRED"` \| `"TX_REPLACED"` \| `"SIGNER_UNAVAILABLE"` \| `"SIGNING_FAILED"` \| `"SIGNATURE_MISMATCH"` \| `"POLICY_REJECTED"` \| `"KEY_NOT_EXPORTABLE"` \| `"IDEMPOTENCY_CONFLICT"` \| `"FENCING"` \| `"VERSION_CONFLICT"` \| `"INVALID_TRANSITION"` \| `"NOT_FOUND"` \| `"SEQUENCE_BUSY"` \| `"STATE_UNRECORDED"` \| `"SCANNER_REORG_TOO_DEEP"` \| `"TIMEOUT"`

##### message

`string`

##### options?

[`CryptoAioErrorOptions`](../interfaces/CryptoAioErrorOptions.md) = `{}`

#### Returns

`CryptoAioError`

#### Overrides

`Error.constructor`

## Properties

<a id="ambiguous"></a>

### ambiguous

> `readonly` **ambiguous**: `boolean`

Defined in: [src/core/errors/error.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L31)

***

<a id="category"></a>

### category

> `readonly` **category**: [`ErrorCategory`](../type-aliases/ErrorCategory.md)

Defined in: [src/core/errors/error.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L29)

***

<a id="cause"></a>

### cause?

> `optional` **cause?**: `unknown`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es2022.error.d.ts:26

#### Inherited from

`Error.cause`

***

<a id="code"></a>

### code

> `readonly` **code**: `"CONFIG_INVALID"` \| `"DEPENDENCY_MISSING"` \| `"INCOMPATIBLE_SELECTION"` \| `"UNSUPPORTED_CAPABILITY"` \| `"INVALID_ADDRESS"` \| `"INVALID_AMOUNT"` \| `"ASSET_RESOLUTION"` \| `"INVALID_INTENT"` \| `"PROVIDER_UNAVAILABLE"` \| `"RATE_LIMITED"` \| `"PROVIDER_MISCONFIGURED"` \| `"PROVIDER_INCONSISTENT"` \| `"RPC_ERROR"` \| `"INSUFFICIENT_FUNDS"` \| `"NONCE_CONFLICT"` \| `"NONCE_TOO_HIGH"` \| `"FEE_TOO_LOW"` \| `"TX_REFUSED"` \| `"TX_REJECTED"` \| `"TX_REVERTED"` \| `"TX_EXPIRED"` \| `"TX_REPLACED"` \| `"SIGNER_UNAVAILABLE"` \| `"SIGNING_FAILED"` \| `"SIGNATURE_MISMATCH"` \| `"POLICY_REJECTED"` \| `"KEY_NOT_EXPORTABLE"` \| `"IDEMPOTENCY_CONFLICT"` \| `"FENCING"` \| `"VERSION_CONFLICT"` \| `"INVALID_TRANSITION"` \| `"NOT_FOUND"` \| `"SEQUENCE_BUSY"` \| `"STATE_UNRECORDED"` \| `"SCANNER_REORG_TOO_DEEP"` \| `"TIMEOUT"`

Defined in: [src/core/errors/error.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L28)

***

<a id="context"></a>

### context

> `readonly` **context**: [`ErrorContext`](../type-aliases/ErrorContext.md)

Defined in: [src/core/errors/error.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L32)

***

<a id="details"></a>

### details?

> `readonly` `optional` **details?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/errors/error.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L33)

***

<a id="message"></a>

### message

> **message**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1077

#### Inherited from

`Error.message`

***

<a id="name"></a>

### name

> **name**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1076

#### Inherited from

`Error.name`

***

<a id="retryable"></a>

### retryable

> `readonly` **retryable**: `boolean`

Defined in: [src/core/errors/error.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L30)

***

<a id="stack"></a>

### stack?

> `optional` **stack?**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1078

#### Inherited from

`Error.stack`

***

<a id="stacktracelimit"></a>

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

Defined in: node\_modules/.pnpm/@types+node@22.20.4/node\_modules/@types/node/globals.d.ts:68

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

#### Inherited from

`Error.stackTraceLimit`

## Methods

<a id="tojson"></a>

### toJSON()

> **toJSON**(): [`SerializedError`](../interfaces/SerializedError.md)

Defined in: [src/core/errors/error.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L47)

#### Returns

[`SerializedError`](../interfaces/SerializedError.md)

***

<a id="capturestacktrace"></a>

### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Defined in: node\_modules/.pnpm/@types+node@22.20.4/node\_modules/@types/node/globals.d.ts:52

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

#### Parameters

##### targetObject

`object`

##### constructorOpt?

`Function`

#### Returns

`void`

#### Inherited from

`Error.captureStackTrace`

***

<a id="preparestacktrace"></a>

### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

Defined in: node\_modules/.pnpm/@types+node@22.20.4/node\_modules/@types/node/globals.d.ts:56

#### Parameters

##### err

`Error`

##### stackTraces

`CallSite`[]

#### Returns

`any`

#### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

`Error.prepareStackTrace`
