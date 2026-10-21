[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MonitorApi

# Interface: MonitorApi

Defined in: [src/core/container/container.ts:331](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L331)

## Methods

<a id="runonce"></a>

### runOnce()

> **runOnce**(`options?`): `Promise`\<`number`\>

Defined in: [src/core/container/container.ts:335](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L335)

One worker pass; resolves to the number of Operations it claimed.

#### Parameters

##### options?

[`WorkerOptions`](WorkerOptions.md)

#### Returns

`Promise`\<`number`\>

***

<a id="start"></a>

### start()

> **start**(`options?`): `Promise`\<`void`\>

Defined in: [src/core/container/container.ts:333](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L333)

Runs worker passes until `signal` aborts; any number of workers may run.

#### Parameters

##### options?

[`WorkerOptions`](WorkerOptions.md)

#### Returns

`Promise`\<`void`\>
