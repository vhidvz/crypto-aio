[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeClock

# Class: FakeClock

Defined in: [src/testing/fake-clock.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L15)

Deterministic clock for tests: time moves only when `advance` is called.

## Implements

- [`Clock`](../../interfaces/Clock.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new FakeClock**(`start?`): `FakeClock`

Defined in: [src/testing/fake-clock.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L20)

#### Parameters

##### start?

`number` = `1_700_000_000_000`

#### Returns

`FakeClock`

## Accessors

<a id="pending"></a>

### pending

#### Get Signature

> **get** **pending**(): `number`

Defined in: [src/testing/fake-clock.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L28)

##### Returns

`number`

## Methods

<a id="advance"></a>

### advance()

> **advance**(`ms`): `Promise`\<`void`\>

Defined in: [src/testing/fake-clock.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L56)

Moves time forward, waking due sleepers in order and settling async work between them.

#### Parameters

##### ms

`number`

#### Returns

`Promise`\<`void`\>

***

<a id="now"></a>

### now()

> **now**(): `number`

Defined in: [src/testing/fake-clock.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L24)

#### Returns

`number`

#### Implementation of

[`Clock`](../../interfaces/Clock.md).[`now`](../../interfaces/Clock.md#now)

***

<a id="sleep"></a>

### sleep()

> **sleep**(`ms`, `signal?`): `Promise`\<`void`\>

Defined in: [src/testing/fake-clock.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L32)

#### Parameters

##### ms

`number`

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Clock`](../../interfaces/Clock.md).[`sleep`](../../interfaces/Clock.md#sleep)
