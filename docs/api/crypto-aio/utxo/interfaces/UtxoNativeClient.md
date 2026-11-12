[crypto-aio](../../../index.md) / [crypto-aio/utxo](../index.md) / UtxoNativeClient

# Interface: UtxoNativeClient

Defined in: [src/adapters/utxo/driver.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L24)

What `native(bc, 'bitcoinjs-lib')` hands out. It mirrors the SDK, so it is outside
semver: a new bitcoinjs-lib line may change it in a minor release.

## Properties

<a id="bitcoin"></a>

### bitcoin

> `readonly` **bitcoin**: `__module`

Defined in: [src/adapters/utxo/driver.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L26)

The bitcoinjs-lib module, with this library's `@noble/curves` ECC backend installed.

***

<a id="network"></a>

### network

> `readonly` **network**: `Network`

Defined in: [src/adapters/utxo/driver.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L28)

A fresh copy of this network's bitcoinjs parameters.

## Methods

<a id="esplora"></a>

### esplora()

> **esplora**\<`T`\>(`path`, `responseType?`): `Promise`\<`T`\>

Defined in: [src/adapters/utxo/driver.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L30)

A GET to the handle's Esplora (`rpc`) endpoints, through the policy-wrapped transport.

#### Type Parameters

<a id="t"></a>

##### T

`T` = `unknown`

#### Parameters

##### path

`string`

##### responseType?

`"json"` \| `"text"`

#### Returns

`Promise`\<`T`\>
