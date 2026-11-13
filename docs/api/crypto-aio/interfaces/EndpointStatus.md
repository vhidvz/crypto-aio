[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointStatus

# Interface: EndpointStatus

Defined in: [src/core/transport/types.ts:173](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L173)

One endpoint's state, as `Transport.status()` and `getNetworkStatus()` report it.

## Properties

<a id="failures"></a>

### failures

> `readonly` **failures**: `number`

Defined in: [src/core/transport/types.ts:179](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L179)

Failures in a row.

***

<a id="height"></a>

### height?

> `readonly` `optional` **height?**: `bigint`

Defined in: [src/core/transport/types.ts:181](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L181)

Its height at the last probe.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/transport/types.ts:175](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L175)

The endpoint's name.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"rpc"` \| `"indexer"`

Defined in: [src/core/transport/types.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L176)

***

<a id="lag"></a>

### lag?

> `readonly` `optional` **lag?**: `bigint`

Defined in: [src/core/transport/types.ts:183](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L183)

How far it is behind the best known height.

***

<a id="latencyms"></a>

### latencyMs?

> `readonly` `optional` **latencyMs?**: `number`

Defined in: [src/core/transport/types.ts:184](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L184)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/transport/types.ts:186](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L186)

Why it is `disabled` (`identity-mismatch`).

***

<a id="state"></a>

### state

> `readonly` **state**: [`EndpointState`](../type-aliases/EndpointState.md)

Defined in: [src/core/transport/types.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L177)
