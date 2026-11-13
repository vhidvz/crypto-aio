[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Clock

# Interface: Clock

Defined in: [src/core/util/clock.ts:5](https://github.com/vhidvz/crypto-aio/blob/main/src/core/util/clock.ts#L5)

The time source of a container (`AioOptions.clock`), its stores and its transports. A
port you may implement: it never gains a required member in a 1.x release.

## Methods

<a id="now"></a>

### now()

> **now**(): `number`

Defined in: [src/core/util/clock.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/core/util/clock.ts#L7)

Milliseconds since the epoch.

#### Returns

`number`

***

<a id="sleep"></a>

### sleep()

> **sleep**(`ms`, `signal?`): `Promise`\<`void`\>

Defined in: [src/core/util/clock.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/util/clock.ts#L9)

Resolves after `ms`, or rejects with the signal's reason once it aborts.

#### Parameters

##### ms

`number`

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>
