[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Hooks

# Interface: Hooks

Defined in: [src/core/config/types.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L80)

## Properties

<a id="beforesign"></a>

### beforeSign?

> `readonly` `optional` **beforeSign?**: (`ctx`) => `void` \| `Promise`\<`void`\>

Defined in: [src/core/config/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L91)

Throw to veto signing (policy engines, approvals). Runs before every signing request.
It may run more than once per Operation: once per concurrent caller, and again when a
`prepared` Operation is repeated. Make it idempotent; `ctx.operationId` identifies the
Operation. It runs while the wallet's address lease is held, so keep it short. In
`transfer` and `submitSignatures` the lease is kept alive for up to
`lifecycle.signTimeoutMs`; in `prepareTransfer` a hook running longer than
`lifecycle.leaseMs` can lose the lease to another transfer. A veto after that writes
nothing; the Operation stays `prepared` and is vetoed again on its next repeat.

#### Parameters

##### ctx

[`SigningContext`](SigningContext.md)

#### Returns

`void` \| `Promise`\<`void`\>
