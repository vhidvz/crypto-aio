[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / ContractTestApi

# Interface: ContractTestApi

Defined in: [src/testing/contracts/api.ts:4](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/api.ts#L4)

Minimal test-framework surface; pass wrappers around your framework's describe/it.

## Methods

<a id="describe"></a>

### describe()

> **describe**(`name`, `fn`): `void`

Defined in: [src/testing/contracts/api.ts:5](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/api.ts#L5)

#### Parameters

##### name

`string`

##### fn

() => `void`

#### Returns

`void`

***

<a id="it"></a>

### it()

> **it**(`name`, `fn`): `void`

Defined in: [src/testing/contracts/api.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/api.ts#L6)

#### Parameters

##### name

`string`

##### fn

() => `Promise`\<`void`\>

#### Returns

`void`
