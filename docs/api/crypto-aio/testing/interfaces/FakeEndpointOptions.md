[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEndpointOptions

# Interface: FakeEndpointOptions

Defined in: [src/testing/fake-chain.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L52)

## Properties

<a id="acceptthenfail"></a>

### acceptThenFail?

> `optional` **acceptThenFail?**: `boolean`

Defined in: [src/testing/fake-chain.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L58)

***

<a id="down"></a>

### down?

> `optional` **down?**: `boolean`

Defined in: [src/testing/fake-chain.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L56)

***

<a id="forkabove"></a>

### forkAbove?

> `optional` **forkAbove?**: `number`

Defined in: [src/testing/fake-chain.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L67)

A single endpoint lying about blocks: above this height its block reads
(`fake_getBlock`, `fake_getBlockHash`) serve a private fork, with other hashes and none
of the chain's transactions, and `fake_getTransaction` does not see transactions mined
there. Heights, nonces, balances and finality stay honest.

***

<a id="forkfinalized"></a>

### forkFinalized?

> `optional` **forkFinalized?**: `boolean`

Defined in: [src/testing/fake-chain.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L60)

***

<a id="html"></a>

### html?

> `optional` **html?**: `boolean`

Defined in: [src/testing/fake-chain.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L57)

***

<a id="identity"></a>

### identity?

> `optional` **identity?**: `string`

Defined in: [src/testing/fake-chain.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L54)

***

<a id="lag"></a>

### lag?

> `optional` **lag?**: `number`

Defined in: [src/testing/fake-chain.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L53)

***

<a id="refusenext"></a>

### refuseNext?

> `optional` **refuseNext?**: `string`

Defined in: [src/testing/fake-chain.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L59)

***

<a id="seesmempool"></a>

### seesMempool?

> `optional` **seesMempool?**: `boolean`

Defined in: [src/testing/fake-chain.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L55)
