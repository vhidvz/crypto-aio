[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoWalletOptions

# Interface: UtxoWalletOptions

Defined in: [src/adapters/utxo/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L36)

`WalletConfig.utxo` (spec §9).

## Properties

<a id="addresstype"></a>

### addressType?

> `readonly` `optional` **addressType?**: [`UtxoAddressType`](../type-aliases/UtxoAddressType.md)

Defined in: [src/adapters/utxo/types.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L37)

***

<a id="allowexternalchangeaddress"></a>

### allowExternalChangeAddress?

> `readonly` `optional` **allowExternalChangeAddress?**: `boolean`

Defined in: [src/adapters/utxo/types.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L47)

A19: send change to a `changeAddress` the wallet's key does not derive (default `false`).
An additive deviation from spec §9: without it, a valid but mistyped address is refused.

***

<a id="changeaddress"></a>

### changeAddress?

> `readonly` `optional` **changeAddress?**: `string`

Defined in: [src/adapters/utxo/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L42)

Where change goes; default: the wallet's own address. It must be derivable from the
wallet's key (any of the four address types), unless `allowExternalChangeAddress` is set.
