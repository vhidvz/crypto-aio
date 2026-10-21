[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OPERATION\_FORMAT

# Variable: OPERATION\_FORMAT

> `const` **OPERATION\_FORMAT**: `1` = `1`

Defined in: [src/core/store/format.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/format.ts#L12)

The format of the Operation records this version writes. A record holds the stored
intent, the family's unsigned transaction and ordering data, and its Attempts; a release
that changes how any of them is stored or read raises this number, and keeps reading
every earlier format. Records written before formats existed (0.1.0) carry none and are
format 1.
