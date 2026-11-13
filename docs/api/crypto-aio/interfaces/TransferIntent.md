[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TransferIntent

# Interface: TransferIntent

Defined in: [src/core/model/intent.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L18)

A transfer to make: `to` and `amount` for one payment, or `outputs` for several (the
`batch-transfer` capability), never both.

## Properties

<a id="amount"></a>

### amount?

> `readonly` `optional` **amount?**: [`AmountInput`](../type-aliases/AmountInput.md)

Defined in: [src/core/model/intent.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L20)

***

<a id="asset"></a>

### asset?

> `readonly` `optional` **asset?**: `string` \| \{ `contract`: `string`; `standard`: `string`; \}

Defined in: [src/core/model/intent.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L23)

`'native'`, a token ref, an asset id, or an alias registered for this chain/network.

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L29)

A speed (default `normal`) or the family's explicit fee override.

***

<a id="from"></a>

### from?

> `readonly` `optional` **from?**: `string`

Defined in: [src/core/model/intent.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L25)

The sending address (default: the handle's wallet's); it must be the wallet's.

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L27)

A public memo or comment (the `memo` capability).

***

<a id="outputs"></a>

### outputs?

> `readonly` `optional` **outputs?**: readonly [`TransferOutputInput`](TransferOutputInput.md)[]

Defined in: [src/core/model/intent.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L21)

***

<a id="to"></a>

### to?

> `readonly` `optional` **to?**: `string`

Defined in: [src/core/model/intent.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L19)
