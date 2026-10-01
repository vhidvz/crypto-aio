[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TronExpiryOrdering

# Interface: TronExpiryOrdering

Defined in: [src/adapters/tron/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L79)

The expiry ordering a Tron build records (F4-R12, F4-R14, F4-R15): the signed expiration,
and the reference block the transaction names for TaPoS. `lastValidHeight` is the height
the build-time head claimed plus the TaPoS window (65,536 blocks), so only its low 16 bits
are signed (`ref_block_bytes`); `refBlockHash` is the signed `ref_block_hash`. A proof
trusts the height only when the solidified block there carries `refBlockHash`; otherwise
it searches the heights TaPoS can match. It is a core `expiry` ordering with one more
property, which the core stores whole.

## Properties

<a id="expiresatms"></a>

### expiresAtMs

> `readonly` **expiresAtMs**: `number`

Defined in: [src/adapters/tron/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L82)

`raw_data.expiration`, in milliseconds: invalid in a block whose parent is at or past it.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"expiry"`

Defined in: [src/adapters/tron/types.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L80)

***

<a id="lastvalidheight"></a>

### lastValidHeight

> `readonly` **lastValidHeight**: `bigint`

Defined in: [src/adapters/tron/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L84)

The reference block's height (as the build-time head claimed it) plus 65,536.

***

<a id="refblockhash"></a>

### refBlockHash

> `readonly` **refBlockHash**: `string`

Defined in: [src/adapters/tron/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L86)

`raw_data.ref_block_hash`: bytes 8..16 of the reference block's id, 16 lower-case hex digits.
