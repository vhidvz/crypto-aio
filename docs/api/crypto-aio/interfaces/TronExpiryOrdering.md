[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronExpiryOrdering

# Interface: TronExpiryOrdering

Defined in: [src/adapters/tron/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L82)

The expiry ordering a Tron build records: the signed expiration, and the reference
block the transaction names for TaPoS. `lastValidHeight` is the height the build-time
head claimed plus the TaPoS window (65,536 blocks), so only its low 16 bits are signed
(`ref_block_bytes`); `refBlockHash` is the signed `ref_block_hash`. A proof trusts the
height only when the solidified block there carries `refBlockHash`, because a forged
head can claim a height whose low 16 bits name a block 65,536 lower; otherwise it
searches the heights TaPoS can match. It is a core `expiry` ordering with one more
property, which the core stores whole. A durable store must keep it exact: a changed
hash or height, or a rounded-down `expiresAtMs`, can prove the transfer expired while
a block holds it.

## Properties

<a id="expiresatms"></a>

### expiresAtMs

> `readonly` **expiresAtMs**: `number`

Defined in: [src/adapters/tron/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L85)

`raw_data.expiration`, in milliseconds: invalid in a block whose parent is at or past it.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"expiry"`

Defined in: [src/adapters/tron/types.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L83)

***

<a id="lastvalidheight"></a>

### lastValidHeight

> `readonly` **lastValidHeight**: `bigint`

Defined in: [src/adapters/tron/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L87)

The reference block's height (as the build-time head claimed it) plus 65,536.

***

<a id="refblockhash"></a>

### refBlockHash

> `readonly` **refBlockHash**: `string`

Defined in: [src/adapters/tron/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L89)

`raw_data.ref_block_hash`: bytes 8..16 of the reference block's id, 16 lower-case hex digits.
