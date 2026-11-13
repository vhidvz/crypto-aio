[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeExt

# Interface: FakeExt

Defined in: [src/testing/fake-driver.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L48)

The fake family's `bc.ext` API.

## Properties

<a id="fake"></a>

### fake

> `readonly` **fake**: `object`

Defined in: [src/testing/fake-driver.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-driver.ts#L49)

#### head()

> **head**(): `Promise`\<`bigint`\>

##### Returns

`Promise`\<`bigint`\>

#### nonceOf()

> **nonceOf**(`address`): `Promise`\<`bigint`\>

##### Parameters

###### address

`string`

##### Returns

`Promise`\<`bigint`\>
