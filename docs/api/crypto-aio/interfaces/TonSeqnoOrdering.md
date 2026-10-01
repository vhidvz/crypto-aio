[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TonSeqnoOrdering

# Interface: TonSeqnoOrdering

Defined in: [src/adapters/ton/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L93)

The seqno ordering a TON build records (F6-R29): the signed seqno and `valid_until`, and
`validFrom`, the chain time the build ran at (the state's `sync_utime`, and never later
than the local clock), in seconds. The message cannot run in a block older than that, less
the builder's chain-time tolerance, so a proof that it was not included walks the
wallet's history back to there, whatever the network's `validForSeconds` is now. It is a
core `seqno` ordering with one more property, which the core stores whole.

## Properties

<a id="kind"></a>

### kind

> `readonly` **kind**: `"seqno"`

Defined in: [src/adapters/ton/types.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L94)

***

<a id="seqno"></a>

### seqno

> `readonly` **seqno**: `bigint`

Defined in: [src/adapters/ton/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L95)

***

<a id="validfrom"></a>

### validFrom

> `readonly` **validFrom**: `number`

Defined in: [src/adapters/ton/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L97)

***

<a id="validuntil"></a>

### validUntil

> `readonly` **validUntil**: `number`

Defined in: [src/adapters/ton/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L96)
