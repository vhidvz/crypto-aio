[crypto-aio](../../index.md) / [crypto-aio](../index.md) / redactDeep

# Function: redactDeep()

> **redactDeep**(`value`, `depth?`): `unknown`

Defined in: [src/core/secret/redact.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/redact.ts#L60)

A copy of `value` safe to log: `Secret`s, values under sensitive keys (key, secret,
token, password, mnemonic, ...) and URLs in text are redacted, bytes become their length,
bigints decimal strings, and nesting stops at `depth`.

## Parameters

### value

`unknown`

### depth?

`number` = `8`

## Returns

`unknown`
