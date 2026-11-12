[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WorkerOptions

# Interface: WorkerOptions

Defined in: [src/core/lifecycle/workers.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L49)

Options of `aio.monitor.start()` and `runOnce()`.

## Properties

<a id="batch"></a>

### batch?

> `readonly` `optional` **batch?**: `number`

Defined in: [src/core/lifecycle/workers.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L54)

How many due Operations one pass claims. Default: 50.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/workers.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L52)

***

<a id="workerid"></a>

### workerId?

> `readonly` `optional` **workerId?**: `string`

Defined in: [src/core/lifecycle/workers.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L51)

Default: a random id per `start` call.
