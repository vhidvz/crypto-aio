[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEndpointOptions

# Interface: FakeEndpointOptions

Defined in: [src/testing/fake-chain.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L60)

How one fake endpoint misbehaves; every option can be changed while a test runs.

## Properties

<a id="acceptthenfail"></a>

### acceptThenFail?

> `optional` **acceptThenFail?**: `boolean`

Defined in: [src/testing/fake-chain.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L72)

Accepts the next broadcast, then answers it with HTTP 504 (an ambiguous send).

***

<a id="down"></a>

### down?

> `optional` **down?**: `boolean`

Defined in: [src/testing/fake-chain.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L68)

Answers every request with HTTP 503.

***

<a id="forkabove"></a>

### forkAbove?

> `optional` **forkAbove?**: `number`

Defined in: [src/testing/fake-chain.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L83)

A single endpoint lying about blocks: above this height its block reads
(`fake_getBlock`, `fake_getBlockHash`) serve a private fork, with other hashes and none
of the chain's transactions, and `fake_getTransaction` does not see transactions mined
there. Heights, nonces, balances and finality stay honest.

***

<a id="forkfinalized"></a>

### forkFinalized?

> `optional` **forkFinalized?**: `boolean`

Defined in: [src/testing/fake-chain.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L76)

Serves another finalized block hash, and no finalized transactions.

***

<a id="html"></a>

### html?

> `optional` **html?**: `boolean`

Defined in: [src/testing/fake-chain.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L70)

Answers every request with an HTML page and HTTP 200.

***

<a id="identity"></a>

### identity?

> `optional` **identity?**: `string`

Defined in: [src/testing/fake-chain.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L64)

The chain id it answers, to test a misconfigured endpoint.

***

<a id="lag"></a>

### lag?

> `optional` **lag?**: `number`

Defined in: [src/testing/fake-chain.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L62)

Blocks it stays behind the head.

***

<a id="refusenext"></a>

### refuseNext?

> `optional` **refuseNext?**: `string`

Defined in: [src/testing/fake-chain.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L74)

Refuses the next broadcast with this message.

***

<a id="seesmempool"></a>

### seesMempool?

> `optional` **seesMempool?**: `boolean`

Defined in: [src/testing/fake-chain.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L66)

Whether it sees the mempool (default `true`).
