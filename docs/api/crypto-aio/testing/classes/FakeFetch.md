[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeFetch

# Class: FakeFetch

Defined in: [src/testing/fake-fetch.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L31)

Scripted fetch: routes by longest URL prefix; unknown hosts fail like a DNS error.

## Constructors

<a id="constructor"></a>

### Constructor

> **new FakeFetch**(): `FakeFetch`

#### Returns

`FakeFetch`

## Properties

<a id="calls"></a>

### calls

> `readonly` **calls**: [`RecordedCall`](../interfaces/RecordedCall.md)[] = `[]`

Defined in: [src/testing/fake-fetch.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L32)

***

<a id="fetch"></a>

### fetch

> `readonly` **fetch**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/testing/fake-fetch.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L45)

#### Parameters

##### input

`string` \| `URL` \| `Request`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>

## Methods

<a id="callsto"></a>

### callsTo()

> **callsTo**(`prefix`): [`RecordedCall`](../interfaces/RecordedCall.md)[]

Defined in: [src/testing/fake-fetch.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L41)

#### Parameters

##### prefix

`string`

#### Returns

[`RecordedCall`](../interfaces/RecordedCall.md)[]

***

<a id="route"></a>

### route()

> **route**(`prefix`, `handler`): `this`

Defined in: [src/testing/fake-fetch.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L35)

#### Parameters

##### prefix

`string`

##### handler

[`FakeHandler`](../type-aliases/FakeHandler.md)

#### Returns

`this`
