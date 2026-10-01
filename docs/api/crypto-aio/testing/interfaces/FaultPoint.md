[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FaultPoint

# Interface: FaultPoint

Defined in: [src/testing/faulty-store.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L20)

## Properties

<a id="method"></a>

### method

> `readonly` **method**: `"create"` \| `"update"` \| `"appendAttempt"` \| `"putObservation"`

Defined in: [src/testing/faulty-store.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L21)

***

<a id="timing"></a>

### timing

> `readonly` **timing**: `"after"` \| `"before"`

Defined in: [src/testing/faulty-store.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L32)

`before`: the write never happens. `after`: the write happens, then the process "dies".

***

<a id="when"></a>

### when?

> `readonly` `optional` **when?**: (`args`) => `boolean`

Defined in: [src/testing/faulty-store.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L30)

Receives the method's arguments, which differ by method; defaults to "always".
- `create`: `[operation]`
- `update`: `[namespace, id, patch, expectedVersion]` (the patch is `args[2]`)
- `appendAttempt`: `[namespace, id, attempt, patch]`, without `expectedVersion`, so the
  patch is `args[3]` and `args[2]` is the Attempt
- `putObservation`: `[observation]`

#### Parameters

##### args

readonly `unknown`[]

#### Returns

`boolean`
