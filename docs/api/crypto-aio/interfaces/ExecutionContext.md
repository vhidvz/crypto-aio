[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ExecutionContext

# Interface: ExecutionContext

Defined in: [src/core/store/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L54)

Frozen at Operation creation; later handle or config changes never affect it.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/store/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L55)

***

<a id="confighash"></a>

### configHash

> `readonly` **configHash**: `string`

Defined in: [src/core/store/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L63)

***

<a id="indexers"></a>

### indexers

> `readonly` **indexers**: readonly `string`[]

Defined in: [src/core/store/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L60)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/store/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L57)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/store/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L56)

***

<a id="providers"></a>

### providers

> `readonly` **providers**: readonly `string`[]

Defined in: [src/core/store/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L59)

Provider names, or `inline:<hash>` for inline configs (never secrets).

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/store/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L62)

***

<a id="wallet"></a>

### wallet

> `readonly` **wallet**: `string`

Defined in: [src/core/store/types.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L61)
