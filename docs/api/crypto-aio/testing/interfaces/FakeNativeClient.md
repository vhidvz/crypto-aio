[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeNativeClient

# Interface: FakeNativeClient

Defined in: [src/testing/fake-driver.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L54)

## Properties

<a id="closes"></a>

### closes

> `readonly` **closes**: `number`

Defined in: [src/testing/fake-driver.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L58)

How many times the driver's `close` for this client ran.

***

<a id="id"></a>

### id

> `readonly` **id**: `number`

Defined in: [src/testing/fake-driver.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L55)

***

<a id="settings"></a>

### settings

> `readonly` **settings**: `Record`\<`string`, `unknown`\>

Defined in: [src/testing/fake-driver.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L56)

## Methods

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`): `Promise`\<`T`\>

Defined in: [src/testing/fake-driver.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L59)

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`[]

#### Returns

`Promise`\<`T`\>
