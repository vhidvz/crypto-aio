[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEnv

# Interface: FakeEnv

Defined in: [src/testing/env.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L50)

## Properties

<a id="address"></a>

### address

> `readonly` **address**: `string`

Defined in: [src/testing/env.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L64)

***

<a id="aio"></a>

### aio

> `readonly` **aio**: [`CryptoAio`](../../classes/CryptoAio.md)

Defined in: [src/testing/env.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L53)

***

<a id="bc"></a>

### bc

> `readonly` **bc**: [`Blockchain`](../../classes/Blockchain.md)\<[`FakeChainId`](../type-aliases/FakeChainId.md)\>

Defined in: [src/testing/env.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L54)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: [`FakeChain`](../classes/FakeChain.md)

Defined in: [src/testing/env.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L52)

***

<a id="chainid"></a>

### chainId

> `readonly` **chainId**: [`FakeChainId`](../type-aliases/FakeChainId.md)

Defined in: [src/testing/env.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L65)

***

<a id="clock"></a>

### clock

> `readonly` **clock**: [`FakeClock`](../classes/FakeClock.md)

Defined in: [src/testing/env.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L51)

***

<a id="signer"></a>

### signer

> `readonly` **signer**: [`Signer`](../../interfaces/Signer.md)

Defined in: [src/testing/env.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L62)

The raw, unfenced `Signer` instance — the same object across every `restart()`
(stateless, never rebuilt). The container itself holds a fenced PROXY of it (see
`generationSigner`), not this object, so an identity assertion against the
container's copy (e.g. `containerOf(aio).effective().signers[id]`) must compare `.id`,
never `===` against this field.

***

<a id="stores"></a>

### stores

> `readonly` **stores**: [`Stores`](../../interfaces/Stores.md)

Defined in: [src/testing/env.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L63)

## Methods

<a id="restart"></a>

### restart()

> **restart**(`options?`): `Promise`\<`FakeEnv`\>

Defined in: [src/testing/env.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L79)

Simulates a process restart: a new container (new pool, bus and owner id) attached to
the same durable state (stores, FakeChain, the one simulated FakeClock). By default the
previous generation's env keeps working — later tasks run two generations concurrently
this way. `{ killPrevious: true }` simulates "the old process died": every clock sleep,
fetch and store call already in flight or issued later on the OLD generation's handles
and stores never settles (neither resolves nor rejects), so it can make no further
progress and no old continuation can write to shared state.

#### Parameters

##### options?

###### killPrevious?

`boolean`

#### Returns

`Promise`\<`FakeEnv`\>

***

<a id="run"></a>

### run()

> **run**\<`T`\>(`promise`, `stepMs?`): `Promise`\<`T`\>

Defined in: [src/testing/env.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L67)

Drives a promise to completion on fake time (100 ms steps by default).

#### Type Parameters

##### T

`T`

#### Parameters

##### promise

`Promise`\<`T`\>

##### stepMs?

`number`

#### Returns

`Promise`\<`T`\>

***

<a id="stranger"></a>

### stranger()

> **stranger**(): `string`

Defined in: [src/testing/env.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L69)

A fresh, unrelated fake-chain address.

#### Returns

`string`
