[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeNativeClient

# Interface: FakeNativeClient

Defined in: [src/testing/fake-driver.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L56)

The fake family's native client, for tests of `crypto-aio/native`.

## Properties

<a id="closes"></a>

### closes

> `readonly` **closes**: `number`

Defined in: [src/testing/fake-driver.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L60)

How many times the driver's `close` for this client ran.

***

<a id="id"></a>

### id

> `readonly` **id**: `number`

Defined in: [src/testing/fake-driver.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L57)

***

<a id="settings"></a>

### settings

> `readonly` **settings**: `Record`\<`string`, `unknown`\>

Defined in: [src/testing/fake-driver.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L58)

## Methods

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`): `Promise`\<`T`\>

Defined in: [src/testing/fake-driver.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L61)

#### Type Parameters

<a id="t"></a>

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`[]

#### Returns

`Promise`\<`T`\>
