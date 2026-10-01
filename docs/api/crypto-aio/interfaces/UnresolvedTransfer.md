[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UnresolvedTransfer

# Interface: UnresolvedTransfer

Defined in: [src/core/model/transaction.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L99)

R35: a transfer whose asset could not be resolved, for example a token with unusable
metadata or a failing decimals call. It has no `asset` and no `amount`: without the
asset's decimals there is no `Amount`. `unresolved` keeps the chain's raw data instead,
and the transaction's `decoding` is `'partial'`. A read never fails on such a transfer;
only a retryable failure fails the read, so it can be retried.

## Extends

- `TransferBase`

## Properties

<a id="amount"></a>

### amount?

> `readonly` `optional` **amount?**: `undefined`

Defined in: [src/core/model/transaction.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L101)

***

<a id="asset"></a>

### asset?

> `readonly` `optional` **asset?**: `undefined`

Defined in: [src/core/model/transaction.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L100)

***

<a id="from"></a>

### from

> `readonly` **from**: readonly [`Address`](../classes/Address.md)[]

Defined in: [src/core/model/transaction.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L79)

#### Inherited from

`TransferBase.from`

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L78)

Deterministic: `${txId}:${locator}`.

#### Inherited from

`TransferBase.id`

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/transaction.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L82)

#### Inherited from

`TransferBase.memo`

***

<a id="source"></a>

### source

> `readonly` **source**: [`TransferSource`](../type-aliases/TransferSource.md)

Defined in: [src/core/model/transaction.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L81)

#### Inherited from

`TransferBase.source`

***

<a id="to"></a>

### to

> `readonly` **to**: [`Address`](../classes/Address.md)

Defined in: [src/core/model/transaction.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L80)

#### Inherited from

`TransferBase.to`

***

<a id="unresolved"></a>

### unresolved

> `readonly` **unresolved**: `object`

Defined in: [src/core/model/transaction.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L102)

#### amount

> `readonly` **amount**: `bigint`

The amount in base units, never scaled.

#### asset

> `readonly` **asset**: [`AssetRef`](../type-aliases/AssetRef.md)

The asset as the chain names it.

#### code

> `readonly` **code**: `"CONFIG_INVALID"` \| `"DEPENDENCY_MISSING"` \| `"INCOMPATIBLE_SELECTION"` \| `"UNSUPPORTED_CAPABILITY"` \| `"INVALID_ADDRESS"` \| `"INVALID_AMOUNT"` \| `"ASSET_RESOLUTION"` \| `"INVALID_INTENT"` \| `"PROVIDER_UNAVAILABLE"` \| `"RATE_LIMITED"` \| `"PROVIDER_MISCONFIGURED"` \| `"PROVIDER_INCONSISTENT"` \| `"RPC_ERROR"` \| `"INSUFFICIENT_FUNDS"` \| `"NONCE_CONFLICT"` \| `"NONCE_TOO_HIGH"` \| `"FEE_TOO_LOW"` \| `"TX_REFUSED"` \| `"TX_REJECTED"` \| `"TX_REVERTED"` \| `"TX_EXPIRED"` \| `"TX_REPLACED"` \| `"SIGNER_UNAVAILABLE"` \| `"SIGNING_FAILED"` \| `"SIGNATURE_MISMATCH"` \| `"POLICY_REJECTED"` \| `"KEY_NOT_EXPORTABLE"` \| `"IDEMPOTENCY_CONFLICT"` \| `"FENCING"` \| `"VERSION_CONFLICT"` \| `"INVALID_TRANSITION"` \| `"NOT_FOUND"` \| `"SEQUENCE_BUSY"` \| `"STATE_UNRECORDED"` \| `"SCANNER_REORG_TOO_DEEP"` \| `"TIMEOUT"`

Why the asset did not resolve, e.g. `ASSET_RESOLUTION`.
