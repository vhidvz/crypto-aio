[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeReply

# Type Alias: FakeReply

> **FakeReply** = `Response` \| \{ `headers?`: `Readonly`\<`Record`\<`string`, `string`\>\>; `json?`: `unknown`; `status?`: `number`; `text?`: `string`; \}

Defined in: [src/testing/fake-fetch.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-fetch.ts#L11)

A handler's answer: a `Response`, or its status (default 200) with a JSON or text body.
