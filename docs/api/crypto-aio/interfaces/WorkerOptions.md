[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WorkerOptions

# Interface: WorkerOptions

Defined in: [src/core/lifecycle/workers.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L48)

## Properties

<a id="batch"></a>

### batch?

> `readonly` `optional` **batch?**: `number`

Defined in: [src/core/lifecycle/workers.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L53)

How many due Operations one pass claims. Default: 50.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/workers.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L51)

***

<a id="workerid"></a>

### workerId?

> `readonly` `optional` **workerId?**: `string`

Defined in: [src/core/lifecycle/workers.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L50)

Default: a random id per `start` call.
