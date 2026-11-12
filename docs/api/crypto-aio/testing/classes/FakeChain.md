[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeChain

# Class: FakeChain

Defined in: [src/testing/fake-chain.ts:201](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L201)

An in-memory chain with nonce, seqno or expiry ordering, served over JSON-RPC through
`fetch` to the fake driver: tests mine, reorg and make endpoints misbehave.

## Constructors

<a id="constructor"></a>

### Constructor

> **new FakeChain**(`options?`): `FakeChain`

Defined in: [src/testing/fake-chain.ts:215](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L215)

#### Parameters

##### options?

[`FakeChainOptions`](../interfaces/FakeChainOptions.md) = `{}`

#### Returns

`FakeChain`

## Properties

<a id="bumppercent"></a>

### bumpPercent

> `readonly` **bumpPercent**: `bigint`

Defined in: [src/testing/fake-chain.ts:206](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L206)

***

<a id="chainid"></a>

### chainId

> `readonly` **chainId**: `string`

Defined in: [src/testing/fake-chain.ts:203](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L203)

***

<a id="fetch"></a>

### fetch

> `readonly` **fetch**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/testing/fake-chain.ts:367](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L367)

#### Parameters

##### input

`string` \| `URL` \| `Request`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>

***

<a id="finalitydepth"></a>

### finalityDepth

> `readonly` **finalityDepth**: `number`

Defined in: [src/testing/fake-chain.ts:204](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L204)

***

<a id="minfee"></a>

### minFee

> `readonly` **minFee**: `bigint`

Defined in: [src/testing/fake-chain.ts:205](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L205)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`FakeOrdering`](../type-aliases/FakeOrdering.md)

Defined in: [src/testing/fake-chain.ts:202](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L202)

## Accessors

<a id="head"></a>

### head

#### Get Signature

> **get** **head**(): `bigint`

Defined in: [src/testing/fake-chain.ts:231](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L231)

##### Returns

`bigint`

## Methods

<a id="balance"></a>

### balance()

> **balance**(`address`, `height?`): `bigint`

Defined in: [src/testing/fake-chain.ts:259](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L259)

#### Parameters

##### address

`string`

##### height?

`bigint` = `...`

#### Returns

`bigint`

***

<a id="block"></a>

### block()

> **block**(`height`): \{ `hash`: `string`; `height`: `bigint`; `parentHash`: `string`; `txIds`: `string`[]; \} \| `undefined`

Defined in: [src/testing/fake-chain.ts:240](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L240)

#### Parameters

##### height

`bigint`

#### Returns

\{ `hash`: `string`; `height`: `bigint`; `parentHash`: `string`; `txIds`: `string`[]; \} \| `undefined`

***

<a id="configureendpoint"></a>

### configureEndpoint()

> **configureEndpoint**(`name`, `patch`): `void`

Defined in: [src/testing/fake-chain.ts:361](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L361)

#### Parameters

##### name

`string`

##### patch

[`FakeEndpointOptions`](../interfaces/FakeEndpointOptions.md)

#### Returns

`void`

***

<a id="dropfrommempool"></a>

### dropFromMempool()

> **dropFromMempool**(`id`): `void`

Defined in: [src/testing/fake-chain.ts:279](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L279)

#### Parameters

##### id

`string`

#### Returns

`void`

***

<a id="endpoint"></a>

### endpoint()

> **endpoint**(`name`, `options?`): `string`

Defined in: [src/testing/fake-chain.ts:356](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L356)

#### Parameters

##### name

`string`

##### options?

[`FakeEndpointOptions`](../interfaces/FakeEndpointOptions.md) = `{}`

#### Returns

`string`

***

<a id="finalizedheight"></a>

### finalizedHeight()

> **finalizedHeight**(): `bigint`

Defined in: [src/testing/fake-chain.ts:235](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L235)

#### Returns

`bigint`

***

<a id="fund"></a>

### fund()

> **fund**(`address`, `amount`): `void`

Defined in: [src/testing/fake-chain.ts:254](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L254)

#### Parameters

##### address

`string`

##### amount

`bigint`

#### Returns

`void`

***

<a id="inmempool"></a>

### inMempool()

> **inMempool**(`id`): `boolean`

Defined in: [src/testing/fake-chain.ts:271](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L271)

#### Parameters

##### id

`string`

#### Returns

`boolean`

***

<a id="mine"></a>

### mine()

> **mine**(`count?`): `void`

Defined in: [src/testing/fake-chain.ts:288](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L288)

#### Parameters

##### count?

`number` = `1`

#### Returns

`void`

***

<a id="nonce"></a>

### nonce()

> **nonce**(`address`, `height?`): `bigint`

Defined in: [src/testing/fake-chain.ts:263](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L263)

#### Parameters

##### address

`string`

##### height?

`bigint` = `...`

#### Returns

`bigint`

***

<a id="receipt"></a>

### receipt()

> **receipt**(`id`, `height?`): [`FakeReceipt`](../interfaces/FakeReceipt.md) \| `undefined`

Defined in: [src/testing/fake-chain.ts:267](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L267)

#### Parameters

##### id

`string`

##### height?

`bigint` = `...`

#### Returns

[`FakeReceipt`](../interfaces/FakeReceipt.md) \| `undefined`

***

<a id="reorg"></a>

### reorg()

> **reorg**(`depth`, `options?`): `void`

Defined in: [src/testing/fake-chain.ts:337](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L337)

Replaces the last `depth` blocks with `depth + 1` new ones; dropped txs do not return.
`options.force` bypasses the finalized-height guard; it exists only to simulate an
adversarial "chain lied about finality" scenario and is never needed for an honest reorg.

#### Parameters

##### depth

`number`

##### options?

###### drop?

readonly `string`[]

###### force?

`boolean`

#### Returns

`void`

***

<a id="sendcount"></a>

### sendCount()

> **sendCount**(`id`): `number`

Defined in: [src/testing/fake-chain.ts:275](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L275)

#### Parameters

##### id

`string`

#### Returns

`number`

***

<a id="submit"></a>

### submit()

> **submit**(`raw`): `string`

Defined in: [src/testing/fake-chain.ts:284](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L284)

Admits a raw transaction directly (bypassing endpoints). Throws the node's error message.

#### Parameters

##### raw

`string`

#### Returns

`string`
