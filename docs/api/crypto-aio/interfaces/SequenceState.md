[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SequenceState

# Interface: SequenceState

Defined in: [src/core/store/types.ts:465](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L465)

The nonce state of one sending address.

## Properties

<a id="fence"></a>

### fence

> `readonly` **fence**: `bigint`

Defined in: [src/core/store/types.ts:471](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L471)

The token of the address lease that last wrote this state.

***

<a id="next"></a>

### next

> `readonly` **next**: `bigint`

Defined in: [src/core/store/types.ts:467](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L467)

The next nonce never handed out.

***

<a id="released"></a>

### released

> `readonly` **released**: readonly `bigint`[]

Defined in: [src/core/store/types.ts:469](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L469)

Nonces handed out and given back, to hand out again before `next`.

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:473](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L473)

Starts at 1 and grows by one on each `put`.
