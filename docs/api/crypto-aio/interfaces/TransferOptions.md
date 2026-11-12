[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TransferOptions

# Interface: TransferOptions

Defined in: [src/core/lifecycle/engine.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/engine.ts#L109)

Options of `bc.transfer()` and its kin: the `idempotencyKey` that makes a repeat return
the same Operation (1 to 200 characters of well-formed text without U+0000; one is
generated when absent), and a `signal` that stops waiting, never a payment already sent.

## Properties

<a id="idempotencykey"></a>

### idempotencyKey?

> `readonly` `optional` **idempotencyKey?**: `string`

Defined in: [src/core/lifecycle/engine.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/engine.ts#L110)

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/engine.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/engine.ts#L111)
