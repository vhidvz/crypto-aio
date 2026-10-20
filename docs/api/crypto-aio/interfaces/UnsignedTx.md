[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UnsignedTx

# Interface: UnsignedTx

Defined in: [src/core/model/transaction.ts:138](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L138)

## Properties

<a id="expectedref"></a>

### expectedRef?

> `readonly` `optional` **expectedRef?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/model/transaction.ts:141](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L141)

Only when identity is fixed before signing (Tron; UTXO with witness-only inputs).

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/model/transaction.ts:144](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L144)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/model/transaction.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L143)

***

<a id="payload"></a>

### payload

> `readonly` **payload**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:139](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L139)

***

<a id="signingrequests"></a>

### signingRequests

> `readonly` **signingRequests**: readonly [`SigningRequest`](SigningRequest.md)[]

Defined in: [src/core/model/transaction.ts:142](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L142)

***

<a id="summary"></a>

### summary

> `readonly` **summary**: [`IntentSummary`](IntentSummary.md)

Defined in: [src/core/model/transaction.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L145)
