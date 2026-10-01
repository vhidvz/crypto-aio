---
title: Errors
description: Every error code, its category, and the safe action for each.
---

# Errors

Every failure the library reports is a `CryptoAioError`. This page lists the classes and
codes, then the safe action for each code. The one rule behind all of it: **never create a new
transfer while the old one might still land.** [Retries, ambiguity and
recovery](../tour/recovery.md) explains why.

## Error classes and codes

Every error is a `CryptoAioError` with `code`, `category`, `retryable`, `ambiguous` and a
redacted `context` (ids such as `operationId`). `ERROR_CODES` maps each code to its
category and default `retryable` flag. Retryable by default: `PROVIDER_UNAVAILABLE`,
`RATE_LIMITED`, `PROVIDER_INCONSISTENT`, `VERSION_CONFLICT`, `SEQUENCE_BUSY`,
`STATE_UNRECORDED` and `TIMEOUT`. `ambiguous` is set per error, never per code: any code can
be ambiguous when its call may have reached the chain.

| Category | Class | Codes |
| --- | --- | --- |
| config | `ConfigError` | `CONFIG_INVALID`, `DEPENDENCY_MISSING`, `INCOMPATIBLE_SELECTION` |
| unsupported | `UnsupportedCapabilityError` | `UNSUPPORTED_CAPABILITY` |
| validation | `ValidationError` | `INVALID_ADDRESS`, `INVALID_AMOUNT`, `ASSET_RESOLUTION`, `INVALID_INTENT` |
| provider | `ProviderError` | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_MISCONFIGURED`, `PROVIDER_INCONSISTENT`, `RPC_ERROR` |
| chain | `ChainError` | `INSUFFICIENT_FUNDS`, `NONCE_CONFLICT`, `NONCE_TOO_HIGH`, `FEE_TOO_LOW`, `TX_REFUSED`, `TX_REJECTED`, `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` |
| signing | `SigningError` | `SIGNER_UNAVAILABLE`, `SIGNING_FAILED`, `SIGNATURE_MISMATCH`, `POLICY_REJECTED`, `KEY_NOT_EXPORTABLE` |
| state | `StateError` | `IDEMPOTENCY_CONFLICT`, `FENCING`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, `SEQUENCE_BUSY`, `STATE_UNRECORDED`, `SCANNER_REORG_TOO_DEEP` |
| timeout | `TimeoutError` | `TIMEOUT` |

## What to do about each error

Find the Operation with `error.context.operationId`, then read its state with
`bc.getOperation(id)`. The rule: **never create a new transfer while the old one might
land.**

| Code | Meaning | Safe action |
| --- | --- | --- |
| `ambiguous: true` (any code) | Outcome unknown, for example a lost broadcast reply | Retry with the **same** key, or let workers resolve it |
| `INVALID_AMOUNT`, `INVALID_ADDRESS`, `INVALID_INTENT`, `ASSET_RESOLUTION` | Input refused; nothing stored | Fix the input |
| `IDEMPOTENCY_CONFLICT` | Key reused for a different intent | Treat it as a bug; inspect the existing Operation |
| `INSUFFICIENT_FUNDS`, `POLICY_REJECTED` with state `failed` | Failed before signing; nonce released | Fix the cause; retry with a **new** key |
| `POLICY_REJECTED` with state `prepared` | The `beforeSign` hook vetoed after the address lease was lost (a `prepareTransfer` hook that outlasted `lifecycle.leaseMs`), so nothing was written | Repeat with the **same** key; the hook runs again |
| `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW`, `NONCE_TOO_HIGH`, `TX_REFUSED` with state `stalled` | Node refused signed bytes | `rebroadcast` after the fix, `replace` or `cancel`; never a new key |
| `NONCE_CONFLICT` | A cancel or replacement lost: the original is already mined | Wait for the original |
| `NONCE_CONFLICT` with `details.heldBy` | The signed transaction is identical to another Operation's, so it would pay once for both; nothing was sent. From `transfer` or `submitSignatures` the Operation is `failed`, or, if it is still `prepared` or `awaiting-signature` (a renew or version conflict), repeat with the **same** key (for `submitSignatures`, resubmit the signatures) so it is refused and failed. From `replace`, `cancel` or `rebuild` it is unchanged | `failed`: retry with a **new** key. `replace` or `cancel`: use another fee spec. `rebuild`: rebuild later. A later build (a new block, or the driver's build variant) gives different bytes |
| `SEQUENCE_BUSY`: "another operation is recording the same transaction; retry" | Another process is recording an identical transaction right now; nothing was recorded | Repeat the call (the **same** key, fee spec or signatures). For `submitSignatures`, resubmit the signatures |
| `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` with state `failed` or `expired` | Proven terminal failure. For `TX_REPLACED`, another transaction is final in the slot | Reconcile; a new transfer with a new key is safe, except for an EVM or Tron token `TX_REVERTED` whose receipt succeeded: value may have moved, so check the chain first ([token verdicts](../build/confirmations.md)) |
| `TX_REJECTED` | Nodes rejected every Attempt as never valid; nonce released | Fix the cause; retry with a **new** key |
| Tron: `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes, or claimed they are invalid; they may still land. A liar and a genuine refusal look the same | Never pay again: repeat only with the **same** key. `rebroadcast` after the fix; `rebuild` only once the Operation is `expired` (see "Lifecycle and `stalled`" above) |
| Tron: `TX_REVERTED` with reason `token transfer not evidenced` | The token call succeeded on chain but logged no `Transfer` to the recipient; value may have moved | Check the chain before you pay again ([Tron token verdicts](../build/confirmations.md)) |
| Solana: `TX_REFUSED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes (often `blockhash not found`), or claimed a signature the library found valid is invalid; they may still land until their window has passed | Never pay again: `rebroadcast` while the blockhash is valid, or repeat only with the **same** key; the workers never resend it. `rebuild` only once the Operation is `expired` |
| TON: ambiguous, or `stalled` after a refusal | toncenter answers every refusal with HTTP 500 ("maybe sent"); the message may land until it expires | Never a new key. Wait for `final`, `failed` or `expired`; `rebuild` only once it is `expired` |
| TON: `TX_REVERTED` with reason `the jetton wallets are not the master’s` | The recipient's jetton wallet is not the one the master names for the recipient (a non-standard jetton); the jettons left your wallet | Check the chain before you pay again ([TON verdicts](../build/confirmations.md)) |
| TON: `TX_REPLACED` | A request signed with the wallet's key, not this transfer, used its seqno | Find what else holds the key and stop it; then a new key is safe |
| `TIMEOUT` | A wait ran out; state unchanged | Wait again |
| `SEQUENCE_BUSY` | A seqno wallet still has a message in flight | Retry later with the same key |
| `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_INCONSISTENT` (not ambiguous) | A read failed | Retry later |
| `PROVIDER_MISCONFIGURED` | The endpoint serves another network | Fix the configuration |
| `SIGNER_UNAVAILABLE` | Watch-only wallet or unknown signer | Use `prepareTransfer`, or fix the configuration |
| `INVALID_TRANSITION` | Not allowed in this state, or the container is closed | Read the state first |
| `UNSUPPORTED_CAPABILITY` | The handle cannot do this | Check `bc.supports(…)` |
| `SCANNER_REORG_TOO_DEEP` | Reorg deeper than the scanner window | Stop crediting; reset the cursor explicitly |
