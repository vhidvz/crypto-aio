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

Defined in: [src/adapters/solana/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L56)

The signature fee: 5,000 lamports per signature of the message. The endpoint's
`getFeeForMessage` quote must be exactly this plus `priorityFee`; any other quote fails
the estimate with a retryable `PROVIDER_UNAVAILABLE`.

***

<a id="computeunitlimit"></a>

### computeUnitLimit

> `readonly` **computeUnitLimit**: `bigint`

Defined in: [src/adapters/solana/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L57)

***

<a id="computeunitprice"></a>

### computeUnitPrice

> `readonly` **computeUnitPrice**: `bigint`

Defined in: [src/adapters/solana/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L59)

Micro-lamports per compute unit.

***

<a id="createsrecipientaccount"></a>

### createsRecipientAccount

> `readonly` **createsRecipientAccount**: `boolean`

Defined in: [src/adapters/solana/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L64)

Whether the transaction creates the recipient's associated token account.

***

<a id="priorityfee"></a>

### priorityFee

> `readonly` **priorityFee**: `bigint`

Defined in: [src/adapters/solana/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L60)

***

<a id="rent"></a>

### rent

> `readonly` **rent**: `bigint`

Defined in: [src/adapters/solana/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L62)

The rent-exempt deposit of a created associated token account; `0n` otherwise.

***

<a id="signatures"></a>

### signatures

> `readonly` **signatures**: `number`

Defined in: [src/adapters/solana/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L50)
