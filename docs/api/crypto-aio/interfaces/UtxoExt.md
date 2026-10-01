[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoExt

# Interface: UtxoExt

Defined in: [src/adapters/utxo/types.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L104)

`bc.ext.utxo`: the UTXO family extension.

## Properties

<a id="utxo"></a>

### utxo

> `readonly` **utxo**: `object`

Defined in: [src/adapters/utxo/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L105)

#### coinSelection()

> **coinSelection**(`request`): `Promise`\<[`UtxoSelectionPreview`](UtxoSelectionPreview.md)\>

What the configured coin selection would pick for these outputs. Signs nothing.

##### Parameters

###### request

[`UtxoSelectionRequest`](UtxoSelectionRequest.md)

##### Returns

`Promise`\<[`UtxoSelectionPreview`](UtxoSelectionPreview.md)\>

#### listUnspent()

> **listUnspent**(`address`): `Promise`\<readonly [`UtxoUnspent`](UtxoUnspent.md)[]\>

Unspent outputs of an address (indexer), confirmed first, oldest first.

##### Parameters

###### address

`string`

##### Returns

`Promise`\<readonly [`UtxoUnspent`](UtxoUnspent.md)[]\>
