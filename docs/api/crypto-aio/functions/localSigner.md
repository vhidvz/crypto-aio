[crypto-aio](../../index.md) / [crypto-aio](../index.md) / localSigner

# Function: localSigner()

> **localSigner**(`options`): [`Signer`](../interfaces/Signer.md)

Defined in: [src/core/signing/local.ts:226](https://github.com/vhidvz/crypto-aio/blob/main/src/core/signing/local.ts#L226)

A signer over raw private keys held in this process. `localSigner.generate()` creates
fresh keys, and `localSigner.fromMnemonic()` derives them from a BIP39 phrase per wallet
`keyRef.path`. For production keys, prefer a custody signer (`callbackSigner`).

## Parameters

### options

[`LocalSignerOptions`](../interfaces/LocalSignerOptions.md)

## Returns

[`Signer`](../interfaces/Signer.md)
