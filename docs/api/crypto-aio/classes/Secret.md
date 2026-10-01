[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Secret

# Class: Secret\<T\>

Defined in: [src/core/secret/secret.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L8)

Wraps sensitive material so that it never renders in logs, JSON or inspection.

## Type Parameters

### T

`T` = `string`

## Constructors

<a id="constructor"></a>

### Constructor

> **new Secret**\<`T`\>(`value`): `Secret`\<`T`\>

Defined in: [src/core/secret/secret.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L9)

#### Parameters

##### value

`T`

#### Returns

`Secret`\<`T`\>

## Methods

<a id="custom"></a>

### \[custom\]()

> **\[custom\]**(): `string`

Defined in: [src/core/secret/secret.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L30)

#### Returns

`string`

***

<a id="toprimitive"></a>

### \[toPrimitive\]()

> **\[toPrimitive\]**(): `string`

Defined in: [src/core/secret/secret.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L26)

#### Returns

`string`

***

<a id="reveal"></a>

### reveal()

> **reveal**(): `T`

Defined in: [src/core/secret/secret.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L14)

#### Returns

`T`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `string`

Defined in: [src/core/secret/secret.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L22)

#### Returns

`string`

***

<a id="tostring"></a>

### toString()

> **toString**(): `string`

Defined in: [src/core/secret/secret.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L18)

#### Returns

`string`
