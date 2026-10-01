[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SolanaExpiryOrdering

# Interface: SolanaExpiryOrdering

Defined in: [src/adapters/solana/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L95)

The expiry ordering a Solana build records (F5-R9): the recent blockhash's
`lastValidBlockHeight`, the blockhash itself and the slot of its block, all from one
`getLatestBlockhash` answer, so one endpoint's word. A verdict rests on the height the
proof quorum attests for `blockhash` instead (F5-R10): the finalized block at
`blockhashSlot`, when it carries the blockhash, gives the last valid height as its own
height plus 150 (agave's `MAX_PROCESSING_AGE`); otherwise the finalized block 150 below
`lastValidHeight` must carry it. No endpoint proposes the height (lesson 17).

## Properties

<a id="blockhash"></a>

### blockhash

> `readonly` **blockhash**: `string`

Defined in: [src/adapters/solana/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L99)

The message's recent blockhash (base58).

***

<a id="blockhashslot"></a>

### blockhashSlot

> `readonly` **blockhashSlot**: `bigint`

Defined in: [src/adapters/solana/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L101)

The slot of the block whose hash `blockhash` is.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"expiry"`

Defined in: [src/adapters/solana/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L96)

***

<a id="lastvalidheight"></a>

### lastValidHeight

> `readonly` **lastValidHeight**: `bigint`

Defined in: [src/adapters/solana/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L97)
