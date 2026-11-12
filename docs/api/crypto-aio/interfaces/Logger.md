[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Logger

# Interface: Logger

Defined in: [src/core/events/logger.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L14)

Where the library logs (`AioOptions.logger`). A port you may implement: it never gains a
required member in a 1.x release. `createLogger` builds one that redacts before writing;
one of your own should redact too, since fields can carry endpoint URLs.

## Methods

<a id="child"></a>

### child()

> **child**(`namespace`): `Logger`

Defined in: [src/core/events/logger.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L20)

A logger for a sub-namespace, such as `transport`.

#### Parameters

##### namespace

`string`

#### Returns

`Logger`

***

<a id="debug"></a>

### debug()

> **debug**(`message`, `fields?`): `void`

Defined in: [src/core/events/logger.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L15)

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

Defined in: [src/core/events/logger.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L18)

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

Defined in: [src/core/events/logger.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L16)

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

Defined in: [src/core/events/logger.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/logger.ts#L17)

#### Parameters

##### message

`string`

##### fields?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

`void`
