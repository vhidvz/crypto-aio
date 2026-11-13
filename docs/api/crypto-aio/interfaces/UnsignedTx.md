[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UnsignedTx

# Interface: UnsignedTx

Defined in: [src/core/model/transaction.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L176)

A transaction built and not yet signed: its payload, the signatures it needs, the slot it
takes, its fee and what it pays. A driver's `summary` describes exactly what the payload
pays: `beforeSign` policies judge the summary, never the bytes.

## Properties

<a id="expectedref"></a>

### expectedRef?

> `readonly` `optional` **expectedRef?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/model/transaction.ts:179](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L179)

Only when identity is fixed before signing (Tron; UTXO with witness-only inputs).

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/model/transaction.ts:182](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L182)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/model/transaction.ts:181](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L181)

***

<a id="payload"></a>

### payload

> `readonly` **payload**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L177)

***

<a id="signingrequests"></a>

### signingRequests

> `readonly` **signingRequests**: readonly [`SigningRequest`](SigningRequest.md)[]

Defined in: [src/core/model/transaction.ts:180](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L180)

***

<a id="summary"></a>

### summary

> `readonly` **summary**: [`IntentSummary`](IntentSummary.md)

Defined in: [src/core/model/transaction.ts:183](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L183)
