[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptRef

# Interface: AttemptRef

Defined in: [src/core/model/transaction.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L20)

Identity of a signed payload. `canonical: false` = not the final protocol tx hash (TON).

## Properties

<a id="canonical"></a>

### canonical

> `readonly` **canonical**: `boolean`

Defined in: [src/core/model/transaction.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L25)

Whether `id` is the transaction hash the chain reports once it is included.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L22)

The id, as the chain spells it.

***

<a id="idkind"></a>

### idKind

> `readonly` **idKind**: [`AttemptIdKind`](../type-aliases/AttemptIdKind.md)

Defined in: [src/core/model/transaction.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L23)
