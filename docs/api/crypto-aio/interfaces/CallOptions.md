[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CallOptions

# Interface: CallOptions

Defined in: [src/core/transport/types.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L35)

## Properties

<a id="exactintegers"></a>

### exactIntegers?

> `readonly` `optional` **exactIntegers?**: `boolean`

Defined in: [src/core/transport/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L68)

A12: parse JSON answers with exact integers: an integer outside the safe range becomes a
`bigint` instead of a rounded number (`rpc`, `rpcRaw` and `http`; health probes always
parse plainly). A quorum key sees the revived values.

***

<a id="fanout"></a>

### fanout?

> `readonly` `optional` **fanout?**: `number`

Defined in: [src/core/transport/types.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L70)

Send to this many endpoints concurrently (raw-transaction broadcasts).

***

<a id="purpose"></a>

### purpose?

> `readonly` `optional` **purpose?**: [`RequestPurpose`](../type-aliases/RequestPurpose.md)

Defined in: [src/core/transport/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L37)

***

<a id="quorum"></a>

### quorum?

> `readonly` `optional` **quorum?**: `number` \| `"proof"`

Defined in: [src/core/transport/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L54)

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

Defined in: [src/core/transport/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L62)

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

Defined in: [src/core/transport/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L36)

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/transport/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L71)

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L72)
