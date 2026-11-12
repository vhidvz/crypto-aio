[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeChainOptions

# Interface: FakeChainOptions

Defined in: [src/testing/fake-chain.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L87)

How the fake chain behaves.

## Properties

<a id="chainid"></a>

### chainId?

> `readonly` `optional` **chainId?**: `string`

Defined in: [src/testing/fake-chain.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L89)

***

<a id="clock"></a>

### clock?

> `readonly` `optional` **clock?**: [`Clock`](../../interfaces/Clock.md)

Defined in: [src/testing/fake-chain.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L96)

***

<a id="finalitydepth"></a>

### finalityDepth?

> `readonly` `optional` **finalityDepth?**: `number`

Defined in: [src/testing/fake-chain.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L91)

Blocks after which a block is final (default 3).

***

<a id="minfee"></a>

### minFee?

> `readonly` `optional` **minFee?**: `bigint`

Defined in: [src/testing/fake-chain.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L93)

The least fee a transaction pays (default 1).

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`FakeOrdering`](../type-aliases/FakeOrdering.md)

Defined in: [src/testing/fake-chain.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L88)

***

<a id="replacementbumppercent"></a>

### replacementBumpPercent?

> `readonly` `optional` **replacementBumpPercent?**: `number`

Defined in: [src/testing/fake-chain.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-chain.ts#L95)

The least fee increase, in percent, a replacement needs (default 10).
