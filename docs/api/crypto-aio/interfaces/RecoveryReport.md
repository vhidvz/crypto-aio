[crypto-aio](../../index.md) / [crypto-aio](../index.md) / RecoveryReport

# Interface: RecoveryReport

Defined in: [src/core/lifecycle/workers.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L26)

What `recover()` did. The counts are per Operation, except `reconciled`, and they
overlap: an Operation whose resend was attempted and whose check then failed counts in
both `rebroadcast` and `failed`.

## Properties

<a id="checked"></a>

### checked

> `readonly` **checked**: `number`

Defined in: [src/core/lifecycle/workers.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L33)

Operations checked on chain after any resend.

***

<a id="failed"></a>

### failed

> `readonly` **failed**: `number`

Defined in: [src/core/lifecycle/workers.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L37)

Operations whose target could not be rebuilt, or whose resend or check threw.

***

<a id="rebroadcast"></a>

### rebroadcast

> `readonly` **rebroadcast**: `number`

Defined in: [src/core/lifecycle/workers.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L31)

`signed` or ambiguously `submitted` Operations whose stored bytes were sent again:
attempted resends, including ones the node refused or whose outcome is unknown.

***

<a id="reconciled"></a>

### reconciled

> `readonly` **reconciled**: `number`

Defined in: [src/core/lifecycle/workers.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L39)

Leaked nonce values that reconciliation returned for reuse (across all wallets).

***

<a id="skipped"></a>

### skipped

> `readonly` **skipped**: `number`

Defined in: [src/core/lifecycle/workers.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/workers.ts#L35)

Operations that need a caller (see `recovery.skipped`); never resent or checked.
