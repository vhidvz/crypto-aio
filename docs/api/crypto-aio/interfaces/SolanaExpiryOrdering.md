[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SolanaExpiryOrdering

# Interface: SolanaExpiryOrdering

Defined in: [src/adapters/solana/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L98)

The expiry ordering a Solana build records: the recent blockhash's
`lastValidBlockHeight`, the blockhash itself and the slot of its block, all from one
`getLatestBlockhash` answer, so one endpoint's word. A verdict rests on the height the
proof quorum attests for `blockhash` instead: the finalized block at
`blockhashSlot`, when it carries the blockhash, gives the last valid height as its own
height plus 150 (agave's `MAX_PROCESSING_AGE`); otherwise the finalized block 150 below
`lastValidHeight` must carry it. No endpoint proposes the height: trusting the recorded
one would let an endpoint that reported it too low prove the transfer expired while it
can still land, and `rebuild` would pay twice. For the same reason a store must keep
this ordering whole and unmodified: a changed `blockhash` misplaces the window.

## Properties

<a id="blockhash"></a>

### blockhash

> `readonly` **blockhash**: `string`

Defined in: [src/adapters/solana/types.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L102)

The message's recent blockhash (base58).

***

<a id="blockhashslot"></a>

### blockhashSlot

> `readonly` **blockhashSlot**: `bigint`

Defined in: [src/adapters/solana/types.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L104)

The slot of the block whose hash `blockhash` is.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"expiry"`

Defined in: [src/adapters/solana/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L99)

***

<a id="lastvalidheight"></a>

### lastValidHeight

> `readonly` **lastValidHeight**: `bigint`

Defined in: [src/adapters/solana/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L100)
