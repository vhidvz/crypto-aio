[crypto-aio](../../index.md) / [crypto-aio](../index.md) / PreparedOperation

# Interface: PreparedOperation

Defined in: [src/core/lifecycle/views.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L38)

## Properties

<a id="operation"></a>

### operation

> `readonly` **operation**: [`OperationView`](OperationView.md)

Defined in: [src/core/lifecycle/views.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L39)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: `object`

Defined in: [src/core/lifecycle/views.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L41)

Present while the Operation awaits signatures (offline, cold or asynchronous signers).

#### expectedRef?

> `readonly` `optional` **expectedRef?**: [`AttemptRef`](AttemptRef.md)

#### fee

> `readonly` **fee**: [`FeeEstimate`](FeeEstimate.md)

#### payload

> `readonly` **payload**: [`RawTx`](RawTx.md)

#### signingRequests

> `readonly` **signingRequests**: readonly [`SigningRequest`](SigningRequest.md)[]
