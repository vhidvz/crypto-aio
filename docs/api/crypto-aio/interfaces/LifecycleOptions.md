[crypto-aio](../../index.md) / [crypto-aio](../index.md) / LifecycleOptions

# Interface: LifecycleOptions

Defined in: [src/core/config/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L97)

Timing and safety of transfers and workers.

## Properties

<a id="broadcastfanout"></a>

### broadcastFanout?

> `readonly` `optional` **broadcastFanout?**: `number`

Defined in: [src/core/config/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L120)

How many endpoints each broadcast goes to (default 1).

***

<a id="claimleasems"></a>

### claimLeaseMs?

> `readonly` `optional` **claimLeaseMs?**: `number`

Defined in: [src/core/config/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L114)

How long a worker's claim on an Operation lasts (default 60 000 ms).

***

<a id="droppedgraceperiodms"></a>

### droppedGracePeriodMs?

> `readonly` `optional` **droppedGracePeriodMs?**: `number`

Defined in: [src/core/config/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L101)

How long an unseen transaction waits before it counts as dropped and is resent (default 120 000 ms).

***

<a id="leasems"></a>

### leaseMs?

> `readonly` `optional` **leaseMs?**: `number`

Defined in: [src/core/config/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L105)

The time-to-live of a wallet's address lease, held while a slot is reserved and signed (default 30 000 ms).

***

<a id="leasewaitms"></a>

### leaseWaitMs?

> `readonly` `optional` **leaseWaitMs?**: `number`

Defined in: [src/core/config/types.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L112)

How long a transfer waits for its wallet's address lease while another Operation of
the wallet holds it, before it fails with `SEQUENCE_BUSY` (default: `leaseMs`). The
holder keeps the lease while its signer works, for up to `signTimeoutMs`, so raise this
to queue transfers behind a slow signer instead of failing them.

***

<a id="pollintervalms"></a>

### pollIntervalMs?

> `readonly` `optional` **pollIntervalMs?**: `number`

Defined in: [src/core/config/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L99)

How often waits and workers observe an Operation (default 5 000 ms).

***

<a id="rebroadcastintervalms"></a>

### rebroadcastIntervalMs?

> `readonly` `optional` **rebroadcastIntervalMs?**: `number`

Defined in: [src/core/config/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L103)

The least time between resends of one Attempt (default 60 000 ms).

***

<a id="requireidempotencykey"></a>

### requireIdempotencyKey?

> `readonly` `optional` **requireIdempotencyKey?**: `boolean`

Defined in: [src/core/config/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L118)

Whether a transfer without an idempotency key is an error (default `false`; set it in production).

***

<a id="signtimeoutms"></a>

### signTimeoutMs?

> `readonly` `optional` **signTimeoutMs?**: `number`

Defined in: [src/core/config/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L127)

How long `transfer` and `submitSignatures` wait for the `beforeSign` hook and the
signer(s) (default 120 000 ms). The wallet's address lease is kept alive meanwhile. On
timeout nothing is written: the Operation stays `prepared` with its reservation, and a
repeat asks again. Signers that need longer should answer `pending` with a ticket.

***

<a id="waittimeoutms"></a>

### waitTimeoutMs?

> `readonly` `optional` **waitTimeoutMs?**: `number`

Defined in: [src/core/config/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L116)

The default timeout of `waitForConfirmation` (default 600 000 ms).
