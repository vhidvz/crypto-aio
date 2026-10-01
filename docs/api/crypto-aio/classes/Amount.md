[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Amount

# Class: Amount

Defined in: [src/core/model/amount.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L13)

An exact, non-negative quantity of one asset in base units. Never floating point.

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: [`AssetInfo`](../interfaces/AssetInfo.md)

Defined in: [src/core/model/amount.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L16)

***

<a id="base"></a>

### base

> `readonly` **base**: `bigint`

Defined in: [src/core/model/amount.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L15)

## Accessors

<a id="decimals"></a>

### decimals

#### Get Signature

> **get** **decimals**(): `number`

Defined in: [src/core/model/amount.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L66)

##### Returns

`number`

## Methods

<a id="compare"></a>

### compare()

> **compare**(`other`): `-1` \| `0` \| `1`

Defined in: [src/core/model/amount.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L98)

#### Parameters

##### other

`Amount`

#### Returns

`-1` \| `0` \| `1`

***

<a id="equals"></a>

### equals()

> **equals**(`other`): `boolean`

Defined in: [src/core/model/amount.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L103)

#### Parameters

##### other

`Amount`

#### Returns

`boolean`

***

<a id="format"></a>

### format()

> **format**(): `string`

Defined in: [src/core/model/amount.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L83)

#### Returns

`string`

***

<a id="iszero"></a>

### isZero()

> **isZero**(): `boolean`

Defined in: [src/core/model/amount.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L70)

#### Returns

`boolean`

***

<a id="minus"></a>

### minus()

> **minus**(`other`): `Amount`

Defined in: [src/core/model/amount.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L92)

#### Parameters

##### other

`Amount`

#### Returns

`Amount`

***

<a id="plus"></a>

### plus()

> **plus**(`other`): `Amount`

Defined in: [src/core/model/amount.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L87)

#### Parameters

##### other

`Amount`

#### Returns

`Amount`

***

<a id="todecimalstring"></a>

### toDecimalString()

> **toDecimalString**(): `string`

Defined in: [src/core/model/amount.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L74)

#### Returns

`string`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `object`

Defined in: [src/core/model/amount.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L107)

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

Defined in: [src/core/model/amount.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L111)

#### Returns

`string`

***

<a id="from"></a>

### from()

> `static` **from**(`input`, `asset`): `Amount`

Defined in: [src/core/model/amount.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L45)

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

Defined in: [src/core/model/amount.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L21)

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

Defined in: [src/core/model/amount.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/amount.ts#L27)

#### Parameters

##### value

`string`

##### asset

[`AssetInfo`](../interfaces/AssetInfo.md)

#### Returns

`Amount`
