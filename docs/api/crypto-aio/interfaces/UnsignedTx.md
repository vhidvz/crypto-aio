[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UnsignedTx

# Interface: UnsignedTx

Defined in: [src/core/model/transaction.ts:130](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L130)

## Properties

<a id="expectedref"></a>

### expectedRef?

> `readonly` `optional` **expectedRef?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/model/transaction.ts:133](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L133)

Only when identity is fixed before signing (Tron; UTXO with witness-only inputs).

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/model/transaction.ts:136](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L136)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/model/transaction.ts:135](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L135)

***

<a id="payload"></a>

### payload

> `readonly` **payload**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L131)

***

<a id="signingrequests"></a>

### signingRequests

> `readonly` **signingRequests**: readonly [`SigningRequest`](SigningRequest.md)[]

Defined in: [src/core/model/transaction.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L134)

***

<a id="summary"></a>

### summary

> `readonly` **summary**: [`IntentSummary`](IntentSummary.md)

Defined in: [src/core/model/transaction.ts:137](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L137)
