[crypto-aio](../../index.md) / [crypto-aio](../index.md) / PreparedOperation

# Interface: PreparedOperation

Defined in: [src/core/lifecycle/views.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L43)

What `prepareTransfer` returns: the Operation, and what to sign elsewhere.

## Properties

<a id="operation"></a>

### operation

> `readonly` **operation**: [`OperationView`](OperationView.md)

Defined in: [src/core/lifecycle/views.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L44)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: `object`

Defined in: [src/core/lifecycle/views.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L46)

Present while the Operation awaits signatures (offline, cold or asynchronous signers).

#### expectedRef?

> `readonly` `optional` **expectedRef?**: [`AttemptRef`](AttemptRef.md)

#### fee

> `readonly` **fee**: [`FeeEstimate`](FeeEstimate.md)

#### payload

> `readonly` **payload**: [`RawTx`](RawTx.md)

#### signingRequests

> `readonly` **signingRequests**: readonly [`SigningRequest`](SigningRequest.md)[]
