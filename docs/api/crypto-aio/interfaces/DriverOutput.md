[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverOutput

# Interface: DriverOutput

Defined in: [src/core/model/intent.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L50)

One output as drivers receive it. `variant` is the recipient address's chain-specific
meaning (`Address.variant`), present only when its chain has one, e.g. TON's
`bounceable` flag (the intent's `to` variant decides bounce behaviour).

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/core/model/intent.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L52)

***

<a id="to"></a>

### to

> `readonly` **to**: `string`

Defined in: [src/core/model/intent.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L51)

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L53)
