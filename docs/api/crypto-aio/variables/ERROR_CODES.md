[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ERROR\_CODES

# Variable: ERROR\_CODES

> `const` **ERROR\_CODES**: `object`

Defined in: [src/core/errors/codes.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/errors/codes.ts#L17)

Frozen (M1), with every entry: the table is shared by every error and every caller.

## Type Declaration

<a id="asset_resolution"></a>

### ASSET\_RESOLUTION

> `readonly` **ASSET\_RESOLUTION**: `object`

#### ASSET\_RESOLUTION.category

> `readonly` **category**: `"validation"` = `'validation'`

#### ASSET\_RESOLUTION.retryable

> `readonly` **retryable**: `false` = `false`

<a id="config_invalid"></a>

### CONFIG\_INVALID

> `readonly` **CONFIG\_INVALID**: `object`

#### CONFIG\_INVALID.category

> `readonly` **category**: `"config"` = `'config'`

#### CONFIG\_INVALID.retryable

> `readonly` **retryable**: `false` = `false`

<a id="dependency_missing"></a>

### DEPENDENCY\_MISSING

> `readonly` **DEPENDENCY\_MISSING**: `object`

#### DEPENDENCY\_MISSING.category

> `readonly` **category**: `"config"` = `'config'`

#### DEPENDENCY\_MISSING.retryable

> `readonly` **retryable**: `false` = `false`

<a id="fee_too_low"></a>

### FEE\_TOO\_LOW

> `readonly` **FEE\_TOO\_LOW**: `object`

#### FEE\_TOO\_LOW.category

> `readonly` **category**: `"chain"` = `'chain'`

#### FEE\_TOO\_LOW.retryable

> `readonly` **retryable**: `false` = `false`

<a id="fencing"></a>

### FENCING

> `readonly` **FENCING**: `object`

#### FENCING.category

> `readonly` **category**: `"state"` = `'state'`

#### FENCING.retryable

> `readonly` **retryable**: `false` = `false`

<a id="idempotency_conflict"></a>

### IDEMPOTENCY\_CONFLICT

> `readonly` **IDEMPOTENCY\_CONFLICT**: `object`

#### IDEMPOTENCY\_CONFLICT.category

> `readonly` **category**: `"state"` = `'state'`

#### IDEMPOTENCY\_CONFLICT.retryable

> `readonly` **retryable**: `false` = `false`

<a id="incompatible_selection"></a>

### INCOMPATIBLE\_SELECTION

> `readonly` **INCOMPATIBLE\_SELECTION**: `object`

#### INCOMPATIBLE\_SELECTION.category

> `readonly` **category**: `"config"` = `'config'`

#### INCOMPATIBLE\_SELECTION.retryable

> `readonly` **retryable**: `false` = `false`

<a id="insufficient_funds"></a>

### INSUFFICIENT\_FUNDS

> `readonly` **INSUFFICIENT\_FUNDS**: `object`

#### INSUFFICIENT\_FUNDS.category

> `readonly` **category**: `"chain"` = `'chain'`

#### INSUFFICIENT\_FUNDS.retryable

> `readonly` **retryable**: `false` = `false`

<a id="invalid_address"></a>

### INVALID\_ADDRESS

> `readonly` **INVALID\_ADDRESS**: `object`

#### INVALID\_ADDRESS.category

> `readonly` **category**: `"validation"` = `'validation'`

#### INVALID\_ADDRESS.retryable

> `readonly` **retryable**: `false` = `false`

<a id="invalid_amount"></a>

### INVALID\_AMOUNT

> `readonly` **INVALID\_AMOUNT**: `object`

#### INVALID\_AMOUNT.category

> `readonly` **category**: `"validation"` = `'validation'`

#### INVALID\_AMOUNT.retryable

> `readonly` **retryable**: `false` = `false`

<a id="invalid_intent"></a>

### INVALID\_INTENT

> `readonly` **INVALID\_INTENT**: `object`

#### INVALID\_INTENT.category

> `readonly` **category**: `"validation"` = `'validation'`

#### INVALID\_INTENT.retryable

> `readonly` **retryable**: `false` = `false`

<a id="invalid_transition"></a>

### INVALID\_TRANSITION

> `readonly` **INVALID\_TRANSITION**: `object`

#### INVALID\_TRANSITION.category

> `readonly` **category**: `"state"` = `'state'`

#### INVALID\_TRANSITION.retryable

> `readonly` **retryable**: `false` = `false`

<a id="key_not_exportable"></a>

### KEY\_NOT\_EXPORTABLE

> `readonly` **KEY\_NOT\_EXPORTABLE**: `object`

#### KEY\_NOT\_EXPORTABLE.category

> `readonly` **category**: `"signing"` = `'signing'`

#### KEY\_NOT\_EXPORTABLE.retryable

> `readonly` **retryable**: `false` = `false`

<a id="nonce_conflict"></a>

### NONCE\_CONFLICT

> `readonly` **NONCE\_CONFLICT**: `object`

#### NONCE\_CONFLICT.category

> `readonly` **category**: `"chain"` = `'chain'`

#### NONCE\_CONFLICT.retryable

> `readonly` **retryable**: `false` = `false`

<a id="nonce_too_high"></a>

### NONCE\_TOO\_HIGH

> `readonly` **NONCE\_TOO\_HIGH**: `object`

#### NONCE\_TOO\_HIGH.category

> `readonly` **category**: `"chain"` = `'chain'`

#### NONCE\_TOO\_HIGH.retryable

> `readonly` **retryable**: `false` = `false`

<a id="not_found"></a>

### NOT\_FOUND

> `readonly` **NOT\_FOUND**: `object`

#### NOT\_FOUND.category

> `readonly` **category**: `"state"` = `'state'`

#### NOT\_FOUND.retryable

> `readonly` **retryable**: `false` = `false`

<a id="policy_rejected"></a>

### POLICY\_REJECTED

> `readonly` **POLICY\_REJECTED**: `object`

#### POLICY\_REJECTED.category

> `readonly` **category**: `"signing"` = `'signing'`

#### POLICY\_REJECTED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="provider_inconsistent"></a>

### PROVIDER\_INCONSISTENT

> `readonly` **PROVIDER\_INCONSISTENT**: `object`

#### PROVIDER\_INCONSISTENT.category

> `readonly` **category**: `"provider"` = `'provider'`

#### PROVIDER\_INCONSISTENT.retryable

> `readonly` **retryable**: `true` = `true`

<a id="provider_misconfigured"></a>

### PROVIDER\_MISCONFIGURED

> `readonly` **PROVIDER\_MISCONFIGURED**: `object`

#### PROVIDER\_MISCONFIGURED.category

> `readonly` **category**: `"provider"` = `'provider'`

#### PROVIDER\_MISCONFIGURED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="provider_unavailable"></a>

### PROVIDER\_UNAVAILABLE

> `readonly` **PROVIDER\_UNAVAILABLE**: `object`

#### PROVIDER\_UNAVAILABLE.category

> `readonly` **category**: `"provider"` = `'provider'`

#### PROVIDER\_UNAVAILABLE.retryable

> `readonly` **retryable**: `true` = `true`

<a id="rate_limited"></a>

### RATE\_LIMITED

> `readonly` **RATE\_LIMITED**: `object`

#### RATE\_LIMITED.category

> `readonly` **category**: `"provider"` = `'provider'`

#### RATE\_LIMITED.retryable

> `readonly` **retryable**: `true` = `true`

<a id="rpc_error"></a>

### RPC\_ERROR

> `readonly` **RPC\_ERROR**: `object`

#### RPC\_ERROR.category

> `readonly` **category**: `"provider"` = `'provider'`

#### RPC\_ERROR.retryable

> `readonly` **retryable**: `false` = `false`

<a id="scanner_reorg_too_deep"></a>

### SCANNER\_REORG\_TOO\_DEEP

> `readonly` **SCANNER\_REORG\_TOO\_DEEP**: `object`

#### SCANNER\_REORG\_TOO\_DEEP.category

> `readonly` **category**: `"state"` = `'state'`

#### SCANNER\_REORG\_TOO\_DEEP.retryable

> `readonly` **retryable**: `false` = `false`

<a id="sequence_busy"></a>

### SEQUENCE\_BUSY

> `readonly` **SEQUENCE\_BUSY**: `object`

#### SEQUENCE\_BUSY.category

> `readonly` **category**: `"state"` = `'state'`

#### SEQUENCE\_BUSY.retryable

> `readonly` **retryable**: `true` = `true`

<a id="signature_mismatch"></a>

### SIGNATURE\_MISMATCH

> `readonly` **SIGNATURE\_MISMATCH**: `object`

#### SIGNATURE\_MISMATCH.category

> `readonly` **category**: `"signing"` = `'signing'`

#### SIGNATURE\_MISMATCH.retryable

> `readonly` **retryable**: `false` = `false`

<a id="signer_unavailable"></a>

### SIGNER\_UNAVAILABLE

> `readonly` **SIGNER\_UNAVAILABLE**: `object`

#### SIGNER\_UNAVAILABLE.category

> `readonly` **category**: `"signing"` = `'signing'`

#### SIGNER\_UNAVAILABLE.retryable

> `readonly` **retryable**: `false` = `false`

<a id="signing_failed"></a>

### SIGNING\_FAILED

> `readonly` **SIGNING\_FAILED**: `object`

#### SIGNING\_FAILED.category

> `readonly` **category**: `"signing"` = `'signing'`

#### SIGNING\_FAILED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="state_unrecorded"></a>

### STATE\_UNRECORDED

> `readonly` **STATE\_UNRECORDED**: `object`

R27: the outcome may have happened (e.g. a delivered broadcast) but was not recorded.

#### STATE\_UNRECORDED.category

> `readonly` **category**: `"state"` = `'state'`

#### STATE\_UNRECORDED.retryable

> `readonly` **retryable**: `true` = `true`

<a id="timeout"></a>

### TIMEOUT

> `readonly` **TIMEOUT**: `object`

#### TIMEOUT.category

> `readonly` **category**: `"timeout"` = `'timeout'`

#### TIMEOUT.retryable

> `readonly` **retryable**: `true` = `true`

<a id="tx_expired"></a>

### TX\_EXPIRED

> `readonly` **TX\_EXPIRED**: `object`

#### TX\_EXPIRED.category

> `readonly` **category**: `"chain"` = `'chain'`

#### TX\_EXPIRED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="tx_refused"></a>

### TX\_REFUSED

> `readonly` **TX\_REFUSED**: `object`

#### TX\_REFUSED.category

> `readonly` **category**: `"chain"` = `'chain'`

#### TX\_REFUSED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="tx_rejected"></a>

### TX\_REJECTED

> `readonly` **TX\_REJECTED**: `object`

#### TX\_REJECTED.category

> `readonly` **category**: `"chain"` = `'chain'`

#### TX\_REJECTED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="tx_replaced"></a>

### TX\_REPLACED

> `readonly` **TX\_REPLACED**: `object`

#### TX\_REPLACED.category

> `readonly` **category**: `"chain"` = `'chain'`

#### TX\_REPLACED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="tx_reverted"></a>

### TX\_REVERTED

> `readonly` **TX\_REVERTED**: `object`

#### TX\_REVERTED.category

> `readonly` **category**: `"chain"` = `'chain'`

#### TX\_REVERTED.retryable

> `readonly` **retryable**: `false` = `false`

<a id="unsupported_capability"></a>

### UNSUPPORTED\_CAPABILITY

> `readonly` **UNSUPPORTED\_CAPABILITY**: `object`

#### UNSUPPORTED\_CAPABILITY.category

> `readonly` **category**: `"unsupported"` = `'unsupported'`

#### UNSUPPORTED\_CAPABILITY.retryable

> `readonly` **retryable**: `false` = `false`

<a id="version_conflict"></a>

### VERSION\_CONFLICT

> `readonly` **VERSION\_CONFLICT**: `object`

#### VERSION\_CONFLICT.category

> `readonly` **category**: `"state"` = `'state'`

#### VERSION\_CONFLICT.retryable

> `readonly` **retryable**: `true` = `true`
