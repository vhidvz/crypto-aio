[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CryptoAioErrorOptions

# Interface: CryptoAioErrorOptions

Defined in: [src/core/errors/error.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L11)

What an error is made with, besides its code and message.

## Properties

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/errors/error.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L18)

Whether the call may have reached the chain (default `false`).

***

<a id="cause"></a>

### cause?

> `readonly` `optional` **cause?**: `unknown`

Defined in: [src/core/errors/error.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L12)

***

<a id="context"></a>

### context?

> `readonly` `optional` **context?**: `Readonly`\<`Record`\<`string`, [`ErrorContextValue`](../type-aliases/ErrorContextValue.md)\>\>

Defined in: [src/core/errors/error.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L13)

***

<a id="details"></a>

### details?

> `readonly` `optional` **details?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/errors/error.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L14)

***

<a id="retryable"></a>

### retryable?

> `readonly` `optional` **retryable?**: `boolean`

Defined in: [src/core/errors/error.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/error.ts#L16)

Overrides the code's default `retryable` flag.
