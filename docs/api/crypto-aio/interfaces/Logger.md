[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Logger

# Interface: Logger

Defined in: [src/core/events/logger.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L7)

## Methods

<a id="child"></a>

### child()

> **child**(`namespace`): `Logger`

Defined in: [src/core/events/logger.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L12)

#### Parameters

##### namespace

`string`

#### Returns

`Logger`

***

<a id="debug"></a>

### debug()

> **debug**(`message`, `fields?`): `void`

Defined in: [src/core/events/logger.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L8)

#### Parameters

##### message

`string`

##### fields?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`void`

***

<a id="error"></a>

### error()

> **error**(`message`, `fields?`): `void`

Defined in: [src/core/events/logger.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L11)

#### Parameters

##### message

`string`

##### fields?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`void`

***

<a id="info"></a>

### info()

> **info**(`message`, `fields?`): `void`

Defined in: [src/core/events/logger.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L9)

#### Parameters

##### message

`string`

##### fields?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`void`

***

<a id="warn"></a>

### warn()

> **warn**(`message`, `fields?`): `void`

Defined in: [src/core/events/logger.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L10)

#### Parameters

##### message

`string`

##### fields?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`void`
