[crypto-aio](../../../index.md) / [crypto-aio/utxo](../index.md) / UtxoNativeClient

# Interface: UtxoNativeClient

Defined in: [src/adapters/utxo/driver.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L20)

## Properties

<a id="bitcoin"></a>

### bitcoin

> `readonly` **bitcoin**: `__module`

Defined in: [src/adapters/utxo/driver.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L22)

The bitcoinjs-lib module, with this library's `@noble/curves` ECC backend installed.

***

<a id="network"></a>

### network

> `readonly` **network**: `Network`

Defined in: [src/adapters/utxo/driver.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L24)

A fresh copy of this network's bitcoinjs parameters.

## Methods

<a id="esplora"></a>

### esplora()

> **esplora**\<`T`\>(`path`, `responseType?`): `Promise`\<`T`\>

Defined in: [src/adapters/utxo/driver.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/driver.ts#L26)

A GET to the handle's Esplora (`rpc`) endpoints, through the policy-wrapped transport.

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### path

`string`

##### responseType?

`"json"` \| `"text"`

#### Returns

`Promise`\<`T`\>
