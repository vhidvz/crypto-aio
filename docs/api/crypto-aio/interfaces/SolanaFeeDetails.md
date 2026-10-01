[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SolanaFeeDetails

# Interface: SolanaFeeDetails

Defined in: [src/adapters/solana/types.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L49)

`FeeEstimate.details` of the `solana` fee kind (lamports; compute-unit price in
micro-lamports). The charges are `network` (the signature fee), `priority`
(`ceil(computeUnitPrice × computeUnitLimit / 1_000_000)`) and, when the recipient's
associated token account is created, `rent`.

## Properties

<a id="basefee"></a>

### baseFee

> `readonly` **baseFee**: `bigint`

Defined in: [src/adapters/solana/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L52)

The signature fee the node quoted for the message (`getFeeForMessage` minus priority).

***

<a id="computeunitlimit"></a>

### computeUnitLimit

> `readonly` **computeUnitLimit**: `bigint`

Defined in: [src/adapters/solana/types.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L53)

***

<a id="computeunitprice"></a>

### computeUnitPrice

> `readonly` **computeUnitPrice**: `bigint`

Defined in: [src/adapters/solana/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L55)

Micro-lamports per compute unit.

***

<a id="createsrecipientaccount"></a>

### createsRecipientAccount

> `readonly` **createsRecipientAccount**: `boolean`

Defined in: [src/adapters/solana/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L60)

Whether the transaction creates the recipient's associated token account.

***

<a id="priorityfee"></a>

### priorityFee

> `readonly` **priorityFee**: `bigint`

Defined in: [src/adapters/solana/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L56)

***

<a id="rent"></a>

### rent

> `readonly` **rent**: `bigint`

Defined in: [src/adapters/solana/types.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L58)

The rent-exempt deposit of a created associated token account; `0n` otherwise.

***

<a id="signatures"></a>

### signatures

> `readonly` **signatures**: `number`

Defined in: [src/adapters/solana/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L50)
