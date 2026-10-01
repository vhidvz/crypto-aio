[crypto-aio](../../../index.md) / [crypto-aio/tron](../index.md) / MAX\_EXPIRATION\_MS

# Variable: MAX\_EXPIRATION\_MS

> `const` **MAX\_EXPIRATION\_MS**: `300000` = `300_000`

Defined in: [src/adapters/tron/network.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/network.ts#L29)

The longest expiration window this driver builds (D3). The negative inclusion proof does
not depend on it: it scans from the reference block to the signed expiration (F4-R12).
