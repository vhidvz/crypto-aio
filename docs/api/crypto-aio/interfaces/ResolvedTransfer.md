[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ResolvedTransfer

# Interface: ResolvedTransfer

Defined in: [src/core/model/transaction.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L120)

A transfer whose asset resolved on this chain and network.

## Extends

- `TransferBase`

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: [`Amount`](../classes/Amount.md)

Defined in: [src/core/model/transaction.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L122)

***

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetInfo`](AssetInfo.md)

Defined in: [src/core/model/transaction.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L121)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly [`Address`](../classes/Address.md)[]

Defined in: [src/core/model/transaction.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L113)

#### Inherited from

`TransferBase.from`

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L112)

Deterministic: `${txId}:${locator}`.

#### Inherited from

`TransferBase.id`

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/transaction.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L116)

#### Inherited from

`TransferBase.memo`

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/model/transaction.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L115)

#### Inherited from

`TransferBase.source`

***

<a id="to"></a>

### to

> `readonly` **to**: [`Address`](../classes/Address.md)

Defined in: [src/core/model/transaction.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L114)

#### Inherited from

`TransferBase.to`

***

<a id="unresolved"></a>

### unresolved?

> `readonly` `optional` **unresolved?**: `undefined`

Defined in: [src/core/model/transaction.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L123)
