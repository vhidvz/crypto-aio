[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeWireBlock

# Interface: FakeWireBlock

Defined in: [src/testing/fake-chain.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L50)

A block as the fake chain's RPC answers it; wire protocol, not covered by semver.

## Properties

<a id="hash"></a>

### hash

> `readonly` **hash**: `string`

Defined in: [src/testing/fake-chain.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L52)

***

<a id="height"></a>

### height

> `readonly` **height**: `string`

Defined in: [src/testing/fake-chain.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L51)

***

<a id="parenthash"></a>

### parentHash

> `readonly` **parentHash**: `string`

Defined in: [src/testing/fake-chain.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L53)

***

<a id="timestamp"></a>

### timestamp

> `readonly` **timestamp**: `number`

Defined in: [src/testing/fake-chain.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L54)

***

<a id="txids"></a>

### txIds

> `readonly` **txIds**: readonly `string`[]

Defined in: [src/testing/fake-chain.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L55)

***

<a id="txs"></a>

### txs?

> `readonly` `optional` **txs?**: readonly [`FakeWireTx`](FakeWireTx.md)[]

Defined in: [src/testing/fake-chain.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L56)
