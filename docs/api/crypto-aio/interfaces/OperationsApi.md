[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationsApi

# Interface: OperationsApi

Defined in: [src/core/container/container.ts:298](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L298)

## Methods

<a id="get"></a>

### get()

> **get**(`id`): `Promise`\<[`OperationView`](OperationView.md) \| `null`\>

Defined in: [src/core/container/container.ts:299](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L299)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`OperationView`](OperationView.md) \| `null`\>

***

<a id="list"></a>

### list()

> **list**(`filter?`): `Promise`\<[`OperationView`](OperationView.md)[]\>

Defined in: [src/core/container/container.ts:301](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L301)

In creation order.

#### Parameters

##### filter?

[`OperationsFilter`](OperationsFilter.md)

#### Returns

`Promise`\<[`OperationView`](OperationView.md)[]\>

***

<a id="recover"></a>

### recover()

> **recover**(`options?`): `Promise`\<[`RecoveryReport`](RecoveryReport.md)\>

Defined in: [src/core/container/container.ts:303](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/container.ts#L303)

Startup recovery for this namespace (see RecoveryReport); it never signs.

#### Parameters

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<[`RecoveryReport`](RecoveryReport.md)\>
