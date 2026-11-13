[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEnv

# Interface: FakeEnv

Defined in: [src/testing/env.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L63)

A container on a fake chain, with a funded wallet and fake time, for tests.

## Properties

<a id="address"></a>

### address

> `readonly` **address**: `string`

Defined in: [src/testing/env.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L79)

The default wallet's address.

***

<a id="aio"></a>

### aio

> `readonly` **aio**: [`CryptoAio`](../../classes/CryptoAio.md)

Defined in: [src/testing/env.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L66)

***

<a id="bc"></a>

### bc

> `readonly` **bc**: [`Blockchain`](../../classes/Blockchain.md)\<[`FakeChainId`](../type-aliases/FakeChainId.md)\>

Defined in: [src/testing/env.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L68)

A handle on the fake chain with the default wallet.

***

<a id="chain"></a>

### chain

> `readonly` **chain**: [`FakeChain`](../classes/FakeChain.md)

Defined in: [src/testing/env.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L65)

***

<a id="chainid"></a>

### chainId

> `readonly` **chainId**: [`FakeChainId`](../type-aliases/FakeChainId.md)

Defined in: [src/testing/env.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L80)

***

<a id="clock"></a>

### clock

> `readonly` **clock**: [`FakeClock`](../classes/FakeClock.md)

Defined in: [src/testing/env.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L64)

***

<a id="signer"></a>

### signer

> `readonly` **signer**: [`Signer`](../../interfaces/Signer.md)

Defined in: [src/testing/env.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L76)

The raw, unfenced `Signer` instance — the same object across every `restart()`
(stateless, never rebuilt). The container itself holds a fenced PROXY of it (see
`generationSigner`), not this object, so an identity assertion against the
container's copy (e.g. `containerOf(aio).effective().signers[id]`) must compare `.id`,
never `===` against this field.

***

<a id="stores"></a>

### stores

> `readonly` **stores**: [`Stores`](../../interfaces/Stores.md)

Defined in: [src/testing/env.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L77)

## Methods

<a id="restart"></a>

### restart()

> **restart**(`options?`): `Promise`\<`FakeEnv`\>

Defined in: [src/testing/env.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L94)

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

Defined in: [src/testing/env.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L82)

Drives a promise to completion on fake time (100 ms steps by default).

#### Type Parameters

<a id="t"></a>

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

Defined in: [src/testing/env.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L84)

A fresh, unrelated fake-chain address.

#### Returns

`string`
