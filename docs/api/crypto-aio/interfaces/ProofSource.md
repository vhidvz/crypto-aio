[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ProofSource

# Interface: ProofSource

Defined in: [src/core/driver/types.ts:190](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L190)

Finalized-state checks behind `proven` verdicts; implementations use quorum reads.
Lesson 18: only a definitive negative proof answers "no". Every other RPC error (state or
history not available, pruned data, indexing in progress, a non-definitive error) throws
a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides nothing.

## Methods

<a id="blockhash"></a>

### blockHash()

> **blockHash**(`height`, `level`): `Promise`\<`string` \| `null`\>

Defined in: [src/core/driver/types.ts:225](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L225)

R33: the hash of the block at `height` on the chain at `level`, or `null` when there is
none yet (above the head, or above the finalized height for `'finalized'`). Confirms
the monitor's orphan decisions and the scanner's rollback and TOO_DEEP verdicts.

#### Parameters

##### height

`bigint`

##### level

[`FinalityLevel`](../type-aliases/FinalityLevel.md)

#### Returns

`Promise`\<`string` \| `null`\>

***

<a id="expired"></a>

### expired()

> **expired**(`ordering`): `Promise`\<`boolean`\>

Defined in: [src/core/driver/types.ts:219](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L219)

Whether expiry has passed per finalized state (expiry/seqno models; false otherwise).

#### Parameters

##### ordering

[`OrderingData`](../type-aliases/OrderingData.md)

#### Returns

`Promise`\<`boolean`\>

***

<a id="finalizedhead"></a>

### finalizedHead()

> **finalizedHead**(): `Promise`\<\{ `hash`: `string`; `height`: `bigint`; `timestamp?`: `number`; \}\>

Defined in: [src/core/driver/types.ts:191](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L191)

#### Returns

`Promise`\<\{ `hash`: `string`; `height`: `bigint`; `timestamp?`: `number`; \}\>

***

<a id="includedfinal"></a>

### includedFinal()

> **includedFinal**(`ref`, `ordering`, `from`): `Promise`\<\{ `included`: `false`; \} \| \{ `blockHash`: `string`; `blockHeight`: `bigint`; `included`: `true`; `reason?`: `string`; `success`: `boolean`; `txHash`: `string`; \}\>

Defined in: [src/core/driver/types.ts:196](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L196)

#### Parameters

##### ref

[`AttemptRef`](AttemptRef.md)

##### ordering

[`OrderingData`](../type-aliases/OrderingData.md)

##### from

`string`

#### Returns

`Promise`\<\{ `included`: `false`; \} \| \{ `blockHash`: `string`; `blockHeight`: `bigint`; `included`: `true`; `reason?`: `string`; `success`: `boolean`; `txHash`: `string`; \}\>

***

<a id="slotconsumed"></a>

### slotConsumed()

> **slotConsumed**(`ordering`, `from`, `level`): `Promise`\<`boolean`\>

Defined in: [src/core/driver/types.ts:213](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L213)

Whether the ordering slot (nonce/seqno/an input) is consumed by ANY transaction at `level`.

#### Parameters

##### ordering

[`OrderingData`](../type-aliases/OrderingData.md)

##### from

`string`

##### level

[`FinalityLevel`](../type-aliases/FinalityLevel.md)

#### Returns

`Promise`\<`boolean`\>
