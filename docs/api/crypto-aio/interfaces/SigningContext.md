[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SigningContext

# Interface: SigningContext

Defined in: [src/core/signing/types.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L47)

Context handed to signers and policy hooks. Never contains secrets or SDK objects.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/signing/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L50)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: [`FeeEstimateDraft`](FeeEstimateDraft.md)

Defined in: [src/core/signing/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L56)

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/signing/types.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L49)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/signing/types.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L51)

***

<a id="operationid"></a>

### operationId

> `readonly` **operationId**: `string`

Defined in: [src/core/signing/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L48)

***

<a id="purpose"></a>

### purpose

> `readonly` **purpose**: [`SigningPurpose`](../type-aliases/SigningPurpose.md)

Defined in: [src/core/signing/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L54)

***

<a id="summary"></a>

### summary

> `readonly` **summary**: [`IntentSummary`](IntentSummary.md)

Defined in: [src/core/signing/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L55)

***

<a id="tier"></a>

### tier?

> `readonly` `optional` **tier?**: `string`

Defined in: [src/core/signing/types.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L53)

***

<a id="unsignedhash"></a>

### unsignedHash

> `readonly` **unsignedHash**: `string`

Defined in: [src/core/signing/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L57)

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: `string`

Defined in: [src/core/signing/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/types.ts#L52)
