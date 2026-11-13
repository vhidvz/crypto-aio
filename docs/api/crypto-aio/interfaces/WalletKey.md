[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WalletKey

# Interface: WalletKey

Defined in: [src/core/driver/types.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L32)

One public key of the sending wallet, with the scheme it signs with.

## Properties

<a id="keyref"></a>

### keyRef?

> `readonly` `optional` **keyRef?**: [`KeyRef`](KeyRef.md)

Defined in: [src/core/driver/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L36)

Where the signer finds the private key, for a signer that holds several.

***

<a id="publickey"></a>

### publicKey

> `readonly` **publicKey**: `Uint8Array`

Defined in: [src/core/driver/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L34)

***

<a id="scheme"></a>

### scheme

> `readonly` **scheme**: `string`

Defined in: [src/core/driver/types.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L33)
