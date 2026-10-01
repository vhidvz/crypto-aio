[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / hang

# Function: hang()

> **hang**(`signal`): `Promise`\<`never`\>

Defined in: [src/testing/fake-fetch.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L94)

A reply that never arrives; rejects with the abort reason when the request is aborted.

## Parameters

### signal

`AbortSignal` \| `undefined`

## Returns

`Promise`\<`never`\>
