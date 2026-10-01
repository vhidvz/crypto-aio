[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverOutput

# Interface: DriverOutput

Defined in: [src/core/model/intent.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L42)

One output as drivers receive it. `variant` is the recipient address's chain-specific
meaning (`Address.variant`), present only when its chain has one, e.g. TON's
`bounceable` flag (the intent's `to` variant decides bounce behaviour).

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/core/model/intent.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L44)

***

<a id="to"></a>

### to

> `readonly` **to**: `string`

Defined in: [src/core/model/intent.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L43)

***

<a id="variant"></a>

### variant?

> `readonly` `optional` **variant?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/intent.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L45)
