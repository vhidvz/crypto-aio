[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeHandler

# Type Alias: FakeHandler

> **FakeHandler** = (`request`, `signal`) => [`FakeReply`](FakeReply.md) \| `Promise`\<[`FakeReply`](FakeReply.md)\>

Defined in: [src/testing/fake-fetch.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L21)

Answers the requests of one route.

## Parameters

### request

[`FakeRequest`](../interfaces/FakeRequest.md)

### signal

`AbortSignal` \| `undefined`

## Returns

[`FakeReply`](FakeReply.md) \| `Promise`\<[`FakeReply`](FakeReply.md)\>
