[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Secret

# Class: Secret\<T\>

Defined in: [src/core/secret/secret.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L9)

Wraps sensitive material so that it never renders in logs, JSON or inspection.

## Type Parameters

<a id="t"></a>

### T

`T` = `string`

## Constructors

<a id="constructor"></a>

### Constructor

> **new Secret**\<`T`\>(`value`): `Secret`\<`T`\>

Defined in: [src/core/secret/secret.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L10)

#### Parameters

##### value

`T`

#### Returns

`Secret`\<`T`\>

## Methods

<a id="custom"></a>

### \[custom\]()

> **\[custom\]**(): `string`

Defined in: [src/core/secret/secret.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L31)

#### Returns

`string`

***

<a id="toprimitive"></a>

### \[toPrimitive\]()

> **\[toPrimitive\]**(): `string`

Defined in: [src/core/secret/secret.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L27)

#### Returns

`string`

***

<a id="reveal"></a>

### reveal()

> **reveal**(): `T`

Defined in: [src/core/secret/secret.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L15)

#### Returns

`T`

***

<a id="tojson"></a>

### toJSON()

> **toJSON**(): `string`

Defined in: [src/core/secret/secret.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L23)

#### Returns

`string`

***

<a id="tostring"></a>

### toString()

> **toString**(): `string`

Defined in: [src/core/secret/secret.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/secret.ts#L19)

#### Returns

`string`
