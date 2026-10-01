[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeChain

# Class: FakeChain

Defined in: [src/testing/fake-chain.ts:169](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L169)

## Constructors

<a id="constructor"></a>

### Constructor

> **new FakeChain**(`options?`): `FakeChain`

Defined in: [src/testing/fake-chain.ts:183](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L183)

#### Parameters

##### options?

[`FakeChainOptions`](../interfaces/FakeChainOptions.md) = `{}`

#### Returns

`FakeChain`

## Properties

<a id="bumppercent"></a>

### bumpPercent

> `readonly` **bumpPercent**: `bigint`

Defined in: [src/testing/fake-chain.ts:174](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L174)

***

<a id="chainid"></a>

### chainId

> `readonly` **chainId**: `string`

Defined in: [src/testing/fake-chain.ts:171](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L171)

***

<a id="fetch"></a>

### fetch

> `readonly` **fetch**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/testing/fake-chain.ts:335](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L335)

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

Defined in: [src/testing/fake-chain.ts:172](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L172)

***

<a id="minfee"></a>

### minFee

> `readonly` **minFee**: `bigint`

Defined in: [src/testing/fake-chain.ts:173](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L173)

***

<a id="ordering"></a>

### ordering

> `readonly` **ordering**: [`FakeOrdering`](../type-aliases/FakeOrdering.md)

Defined in: [src/testing/fake-chain.ts:170](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L170)

## Accessors

<a id="head"></a>

### head

#### Get Signature

> **get** **head**(): `bigint`

Defined in: [src/testing/fake-chain.ts:199](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L199)

##### Returns

`bigint`

## Methods

<a id="balance"></a>

### balance()

> **balance**(`address`, `height?`): `bigint`

Defined in: [src/testing/fake-chain.ts:227](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L227)

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

Defined in: [src/testing/fake-chain.ts:208](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L208)

#### Parameters

##### height

`bigint`

#### Returns

\{ `hash`: `string`; `height`: `bigint`; `parentHash`: `string`; `txIds`: `string`[]; \} \| `undefined`

***

<a id="configureendpoint"></a>

### configureEndpoint()

> **configureEndpoint**(`name`, `patch`): `void`

Defined in: [src/testing/fake-chain.ts:329](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L329)

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

Defined in: [src/testing/fake-chain.ts:247](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L247)

#### Parameters

##### id

`string`

#### Returns

`void`

***

<a id="endpoint"></a>

### endpoint()

> **endpoint**(`name`, `options?`): `string`

Defined in: [src/testing/fake-chain.ts:324](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L324)

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

Defined in: [src/testing/fake-chain.ts:203](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L203)

#### Returns

`bigint`

***

<a id="fund"></a>

### fund()

> **fund**(`address`, `amount`): `void`

Defined in: [src/testing/fake-chain.ts:222](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L222)

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

Defined in: [src/testing/fake-chain.ts:239](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L239)

#### Parameters

##### id

`string`

#### Returns

`boolean`

***

<a id="mine"></a>

### mine()

> **mine**(`count?`): `void`

Defined in: [src/testing/fake-chain.ts:256](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L256)

#### Parameters

##### count?

`number` = `1`

#### Returns

`void`

***

<a id="nonce"></a>

### nonce()

> **nonce**(`address`, `height?`): `bigint`

Defined in: [src/testing/fake-chain.ts:231](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L231)

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

Defined in: [src/testing/fake-chain.ts:235](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L235)

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

Defined in: [src/testing/fake-chain.ts:305](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L305)

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

Defined in: [src/testing/fake-chain.ts:243](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L243)

#### Parameters

##### id

`string`

#### Returns

`number`

***

<a id="submit"></a>

### submit()

> **submit**(`raw`): `string`

Defined in: [src/testing/fake-chain.ts:252](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L252)

Admits a raw transaction directly (bypassing endpoints). Throws the node's error message.

#### Parameters

##### raw

`string`

#### Returns

`string`
