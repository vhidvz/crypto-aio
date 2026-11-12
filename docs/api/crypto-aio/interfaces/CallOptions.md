[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CallOptions

# Interface: CallOptions

Defined in: [src/core/transport/types.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L72)

How a driver's call is routed, retried and cross-checked.

## Properties

<a id="endpointlimit"></a>

### endpointLimit?

> `readonly` `optional` **endpointLimit?**: (`refusal`) => `boolean`

Defined in: [src/core/transport/types.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L115)

Whether a definitive refusal is the endpoint's own limit rather than an answer about
the request, such as an indexer that will not scan an address with a long history.
A read without `quorum` or `fanout` then asks an endpoint it has not asked yet, without
using up a retry; the refusal stands only when every endpoint has refused. Quorum and
fanout calls ignore it.

#### Parameters

##### refusal

[`CryptoAioError`](../classes/CryptoAioError.md)

#### Returns

`boolean`

***

<a id="exactintegers"></a>

### exactIntegers?

> `readonly` `optional` **exactIntegers?**: `boolean`

Defined in: [src/core/transport/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L107)

Parse JSON answers with exact integers: an integer outside the safe range becomes a
`bigint` instead of a rounded number (`rpc`, `rpcRaw` and `http`; health probes always
parse plainly). A quorum key sees the revived values.

***

<a id="fanout"></a>

### fanout?

> `readonly` `optional` **fanout?**: `number`

Defined in: [src/core/transport/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L117)

Send to this many endpoints concurrently (raw-transaction broadcasts).

***

<a id="purpose"></a>

### purpose?

> `readonly` `optional` **purpose?**: [`RequestPurpose`](../type-aliases/RequestPurpose.md)

Defined in: [src/core/transport/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L76)

Default `read`, or `proof` when `quorum` is set.

***

<a id="quorum"></a>

### quorum?

> `readonly` `optional` **quorum?**: `number` \| `"proof"`

Defined in: [src/core/transport/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L93)

Independent endpoints that must agree; `'proof'` uses `proofQuorum`, capped by the
endpoints the quorum counts. A proof quorum (`'proof'` under any purpose, or any quorum
for a monitor or proof purpose) with probes configured counts every endpoint not proven
mismatched until three health refreshes in a row, at most one per `healthIntervalMs`,
fail its probes or find its requests failing (its circuit breaker not closed), even
while it cannot answer, so a shortfall decides nothing (a retryable
`PROVIDER_UNAVAILABLE`); any other quorum counts the usable endpoints. An endpoint out
of a proof quorum's count never answers toward the read: while its circuit breaker is
half-open it is tried alongside the others (the read waits for that trial, up to its
timeout, unless the endpoint has no rate-limit token free), and its disagreement or
refusal can only block the read. In a proof quorum, a definitive error decides only when
every endpoint asked returns an equivalent one: the same error code, HTTP status and
JSON-RPC code, and for a JSON-RPC code each server defines (-32000 to -32099, and
-32603) the same message. Otherwise the read is a retryable `PROVIDER_INCONSISTENT`.

***

<a id="quorumkey"></a>

### quorumKey?

> `readonly` `optional` **quorumKey?**: (`result`) => `unknown`

Defined in: [src/core/transport/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L101)

The part of each endpoint's result that must agree under `quorum` (default: the whole
result). Lets a caller compare consensus facts only, e.g. a block's number, hash and
parent hash, not fields that node implementations format differently. The call still
resolves with the first endpoint's whole result. A key that throws on any result counts
as a disagreement (a retryable `PROVIDER_INCONSISTENT`).

#### Parameters

##### result

`unknown`

#### Returns

`unknown`

***

<a id="retry"></a>

### retry?

> `readonly` `optional` **retry?**: [`RetryClass`](../type-aliases/RetryClass.md)

Defined in: [src/core/transport/types.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L74)

Default `safe`.

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/transport/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L119)

Aborts the call between and during attempts.

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L121)

Overrides each attempt's timeout.
