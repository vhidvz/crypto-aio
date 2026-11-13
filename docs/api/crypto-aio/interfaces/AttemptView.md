[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptView

# Interface: AttemptView

Defined in: [src/core/lifecycle/views.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L14)

Public view of an Attempt: one signed transaction of an Operation.

## Properties

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/lifecycle/views.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L21)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/lifecycle/views.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L15)

***

<a id="purpose"></a>

### purpose

> `readonly` **purpose**: [`AttemptPurpose`](../type-aliases/AttemptPurpose.md)

Defined in: [src/core/lifecycle/views.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L18)

***

<a id="ref"></a>

### ref

> `readonly` **ref**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/lifecycle/views.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L17)

The transaction's id as the chain reports it.

***

<a id="status"></a>

### status?

> `readonly` `optional` **status?**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/lifecycle/views.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L23)

What the chain shows of it, once observed.

***

<a id="supersedes"></a>

### supersedes?

> `readonly` `optional` **supersedes?**: `string`

Defined in: [src/core/lifecycle/views.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L20)

The Attempt this one replaces or cancels.
