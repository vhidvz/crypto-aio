[crypto-aio](../../index.md) / [crypto-aio](../index.md) / redactUrl

# Function: redactUrl()

> **redactUrl**(`url`): `string`

Defined in: [src/core/secret/redact.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/secret/redact.ts#L13)

A URL safe to log: a `Secret` URL keeps only its scheme and host; otherwise credentials,
query values and path segments that look like keys are replaced with `REDACTED`.

## Parameters

### url

`string` \| [`Secret`](../classes/Secret.md)\<`string`\>

## Returns

`string`
