[crypto-aio](../../index.md) / [crypto-aio](../index.md) / configure

# Function: configure()

> **configure**(`options`): [`CryptoAio`](../classes/CryptoAio.md)

Defined in: [src/core/container/default.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/container/default.ts#L67)

Merges options into the default container. Existing handles keep their frozen config; the
stores are carried over key by key (not wholesale) so Operations stay visible even across
a `configure()` call that names only some of them. Intended for application startup.

Each call starts a new generation of the default container (a new event bus, owner id and
driver pool); it never closes the previous one.

## Parameters

### options

[`AioOptions`](../interfaces/AioOptions.md)

## Returns

[`CryptoAio`](../classes/CryptoAio.md)
