[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LifecycleOptions

# Interface: LifecycleOptions

Defined in: [src/core/config/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L62)

## Properties

<a id="broadcastfanout"></a>

### broadcastFanout?

> `readonly` `optional` **broadcastFanout?**: `number`

Defined in: [src/core/config/types.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L70)

***

<a id="claimleasems"></a>

### claimLeaseMs?

> `readonly` `optional` **claimLeaseMs?**: `number`

Defined in: [src/core/config/types.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L67)

***

<a id="droppedgraceperiodms"></a>

### droppedGracePeriodMs?

> `readonly` `optional` **droppedGracePeriodMs?**: `number`

Defined in: [src/core/config/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L64)

***

<a id="leasems"></a>

### leaseMs?

> `readonly` `optional` **leaseMs?**: `number`

Defined in: [src/core/config/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L66)

***

<a id="pollintervalms"></a>

### pollIntervalMs?

> `readonly` `optional` **pollIntervalMs?**: `number`

Defined in: [src/core/config/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L63)

***

<a id="rebroadcastintervalms"></a>

### rebroadcastIntervalMs?

> `readonly` `optional` **rebroadcastIntervalMs?**: `number`

Defined in: [src/core/config/types.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L65)

***

<a id="requireidempotencykey"></a>

### requireIdempotencyKey?

> `readonly` `optional` **requireIdempotencyKey?**: `boolean`

Defined in: [src/core/config/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L69)

***

<a id="signtimeoutms"></a>

### signTimeoutMs?

> `readonly` `optional` **signTimeoutMs?**: `number`

Defined in: [src/core/config/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L77)

How long `transfer` and `submitSignatures` wait for the `beforeSign` hook and the
signer(s) (default 120 000 ms). The wallet's address lease is kept alive meanwhile. On
timeout nothing is written: the Operation stays `prepared` with its reservation, and a
repeat asks again. Signers that need longer should answer `pending` with a ticket.

***

<a id="waittimeoutms"></a>

### waitTimeoutMs?

> `readonly` `optional` **waitTimeoutMs?**: `number`

Defined in: [src/core/config/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L68)
