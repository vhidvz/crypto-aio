[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ResolvedTransfer

# Interface: ResolvedTransfer

Defined in: [src/core/model/transaction.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L94)

A transfer whose asset resolved on this chain and network.

## Extends

- `TransferBase`

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: [`Amount`](../classes/Amount.md)

Defined in: [src/core/model/transaction.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L96)

***

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetInfo`](AssetInfo.md)

Defined in: [src/core/model/transaction.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L95)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly [`Address`](../classes/Address.md)[]

Defined in: [src/core/model/transaction.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L87)

#### Inherited from

`TransferBase.from`

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L86)

Deterministic: `${txId}:${locator}`.

#### Inherited from

`TransferBase.id`

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/transaction.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L90)

#### Inherited from

`TransferBase.memo`

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/model/transaction.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L89)

#### Inherited from

`TransferBase.source`

***

<a id="to"></a>

### to

> `readonly` **to**: [`Address`](../classes/Address.md)

Defined in: [src/core/model/transaction.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L88)

#### Inherited from

`TransferBase.to`

***

<a id="unresolved"></a>

### unresolved?

> `readonly` `optional` **unresolved?**: `undefined`

Defined in: [src/core/model/transaction.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L97)
