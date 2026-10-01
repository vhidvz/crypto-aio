[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WorkerOptions

# Interface: WorkerOptions

Defined in: [src/core/lifecycle/workers.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L42)

## Properties

<a id="batch"></a>

### batch?

> `readonly` `optional` **batch?**: `number`

Defined in: [src/core/lifecycle/workers.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L47)

How many due Operations one pass claims. Default: 50.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/workers.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L45)

***

<a id="workerid"></a>

### workerId?

> `readonly` `optional` **workerId?**: `string`

Defined in: [src/core/lifecycle/workers.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L44)

Default: a random id per `start` call.
