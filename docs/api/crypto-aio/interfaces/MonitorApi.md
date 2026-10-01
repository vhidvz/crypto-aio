[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MonitorApi

# Interface: MonitorApi

Defined in: [src/core/container/container.ts:306](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L306)

## Methods

<a id="runonce"></a>

### runOnce()

> **runOnce**(`options?`): `Promise`\<`number`\>

Defined in: [src/core/container/container.ts:310](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L310)

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

Defined in: [src/core/container/container.ts:308](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L308)

Runs worker passes until `signal` aborts; any number of workers may run.

#### Parameters

##### options?

[`WorkerOptions`](WorkerOptions.md)

#### Returns

`Promise`\<`void`\>
