[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TransferIntent

# Interface: TransferIntent

Defined in: [src/core/model/intent.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L13)

## Properties

<a id="amount"></a>

### amount?

> `readonly` `optional` **amount?**: [`AmountInput`](../type-aliases/AmountInput.md)

Defined in: [src/core/model/intent.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L15)

***

<a id="asset"></a>

### asset?

> `readonly` `optional` **asset?**: `string` \| \{ `contract`: `string`; `standard`: `string`; \}

Defined in: [src/core/model/intent.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L18)

`'native'`, a token ref, an asset id, or an alias registered for this chain/network.

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L21)

***

<a id="from"></a>

### from?

> `readonly` `optional` **from?**: `string`

Defined in: [src/core/model/intent.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L19)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L20)

***

<a id="outputs"></a>

### outputs?

> `readonly` `optional` **outputs?**: readonly [`TransferOutputInput`](TransferOutputInput.md)[]

Defined in: [src/core/model/intent.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L16)

***

<a id="to"></a>

### to?

> `readonly` `optional` **to?**: `string`

Defined in: [src/core/model/intent.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L14)
