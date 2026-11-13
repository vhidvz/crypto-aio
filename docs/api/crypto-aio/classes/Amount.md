[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Amount

# Class: Amount

Defined in: [src/core/model/amount.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L18)

An exact, non-negative quantity of one asset in base units. Never floating point.

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetInfo`](../interfaces/AssetInfo.md)

Defined in: [src/core/model/amount.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L21)

***

<a id="base"></a>

### base

> `readonly` **base**: `bigint`

Defined in: [src/core/model/amount.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L20)

## Accessors

<a id="decimals"></a>

### decimals

#### Get Signature

> **get** **decimals**(): `number`

Defined in: [src/core/model/amount.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L71)

##### Returns

`number`

## Methods

<a id="compare"></a>

### compare()

> **compare**(`other`): `-1` \| `0` \| `1`

Defined in: [src/core/model/amount.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L103)

#### Parameters

##### other

`Amount`

#### Returns

`-1` \| `0` \| `1`

***

<a id="equals"></a>

### equals()

> **equals**(`other`): `boolean`

Defined in: [src/core/model/amount.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L108)

#### Parameters

##### other

`Amount`

#### Returns

`boolean`

***

<a id="format"></a>

### format()

> **format**(): `string`

Defined in: [src/core/model/amount.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L88)

#### Returns

`string`

***

<a id="iszero"></a>

### isZero()

> **isZero**(): `boolean`

Defined in: [src/core/model/amount.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L75)

#### Returns

`boolean`

***

<a id="minus"></a>

### minus()

> **minus**(`other`): `Amount`

Defined in: [src/core/model/amount.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L97)

#### Parameters

##### other

`Amount`

#### Returns

`Amount`

***

<a id="plus"></a>

### plus()

> **plus**(`other`): `Amount`

Defined in: [src/core/model/amount.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L92)

#### Parameters

##### other

`Amount`

#### Returns

`Amount`

***

<a id="todecimalstring"></a>

### toDecimalString()

> **toDecimalString**(): `string`

Defined in: [src/core/model/amount.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L79)

#### Returns

`string`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `object`

Defined in: [src/core/model/amount.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L112)

#### Returns

`object`

##### asset

> **asset**: `string`

##### base

> **base**: `string`

***

<a id="tostring"></a>

### toString()

> **toString**(): `string`

Defined in: [src/core/model/amount.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L116)

#### Returns

`string`

***

<a id="from"></a>

### from()

> `static` **from**(`input`, `asset`): `Amount`

Defined in: [src/core/model/amount.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L50)

#### Parameters

##### input

`unknown`

##### asset

[`AssetInfo`](../interfaces/AssetInfo.md)

#### Returns

`Amount`

***

<a id="frombase"></a>

### fromBase()

> `static` **fromBase**(`base`, `asset`): `Amount`

Defined in: [src/core/model/amount.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L26)

#### Parameters

##### base

`bigint`

##### asset

[`AssetInfo`](../interfaces/AssetInfo.md)

#### Returns

`Amount`

***

<a id="parse"></a>

### parse()

> `static` **parse**(`value`, `asset`): `Amount`

Defined in: [src/core/model/amount.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L32)

#### Parameters

##### value

`string`

##### asset

[`AssetInfo`](../interfaces/AssetInfo.md)

#### Returns

`Amount`
