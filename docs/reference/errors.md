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

Every error is a `CryptoAioError` with `code`, `category`, `retryable`, `ambiguous`, a
redacted `context` (ids such as `operationId`) and, for some codes, `details`
([Error fields](#error-fields)). `ERROR_CODES` maps each code to its
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
| chain | `ChainError` | `INSUFFICIENT_FUNDS`, `NONCE_CONFLICT`, `NONCE_TOO_HIGH`, `FEE_TOO_LOW`, `TX_REFUSED`, `TX_REJECTED`, `TX_REVERTED`, `TX_UNEVIDENCED`, `TX_EXPIRED`, `TX_REPLACED` |
| signing | `SigningError` | `SIGNER_UNAVAILABLE`, `SIGNING_FAILED`, `SIGNATURE_MISMATCH`, `POLICY_REJECTED`, `KEY_NOT_EXPORTABLE` |
| state | `StateError` | `IDEMPOTENCY_CONFLICT`, `FENCING`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, `SEQUENCE_BUSY`, `STATE_UNRECORDED`, `SCANNER_REORG_TOO_DEEP`, `RECORD_FORMAT_UNSUPPORTED` |
| timeout | `TimeoutError` | `TIMEOUT` |

## What to do about each error

Find the Operation with `error.context.operationId`, then read its state with
`bc.getOperation(id)`. The rule: **never create a new transfer while the old one might
land.**

| Code | Meaning | Safe action |
| --- | --- | --- |
| `ambiguous: true` (any code) | Outcome unknown, for example a lost broadcast reply | Retry with the **same** key, or let workers resolve it |
| `STATE_UNRECORDED` | Always ambiguous: the bytes may have reached the network, but their outcome could not be stored (`details.causeCode` names the original code) | Retry with the **same** key, or let workers and `recover()` resolve it; never a new key |
| `INVALID_AMOUNT`, `INVALID_ADDRESS`, `INVALID_INTENT`, `ASSET_RESOLUTION` | Input refused. Most checks run before anything is stored. A driver's check while the transfer is prepared (an EVM gas limit above `maxGasLimit`, a deprecated token, a Bitcoin fee above its bound, a Solana mint's decimals) fails the stored Operation instead; nothing was signed | Fix the input. If the Operation was stored and failed, use a **new** key: the corrected intent under the old key fails with `IDEMPOTENCY_CONFLICT` |
| `CONFIG_INVALID`, `INCOMPATIBLE_SELECTION` | The configuration is wrong: an unknown option or name, a wallet whose signer lacks a scheme it signs with, a plugin driver that does not implement what its manifest declares (`details.missing`); `INCOMPATIBLE_SELECTION` for a library the chain has no driver for, or `native()` asked for another library than the handle's | Fix the configuration; nothing was stored |
| `DEPENDENCY_MISSING` | The chain's SDK is not installed (`details.packages` names it) | Install the package |
| `IDEMPOTENCY_CONFLICT` | Key reused for a different intent | Treat it as a bug; inspect the existing Operation |
| `INSUFFICIENT_FUNDS`, `POLICY_REJECTED` with state `failed` | Failed before signing; nonce released (`details.required` and `details.available` for funds) | Fix the cause; retry with a **new** key |
| `POLICY_REJECTED` with state `prepared` | The `beforeSign` hook vetoed after the address lease was lost (a `prepareTransfer` hook that outlasted `lifecycle.leaseMs`), so nothing was written | Repeat with the **same** key; the hook runs again |
| `SIGNER_UNAVAILABLE` | Watch-only wallet or unknown signer | Use `prepareTransfer`, or fix the configuration |
| `SIGNING_FAILED` | A signer failed or returned no or a malformed answer; nothing was signed, and the Operation stays `prepared` | Fix the signer; repeat with the **same** key |
| `SIGNATURE_MISMATCH` | A signature does not verify against the wallet's key. From a signer during `transfer`, the Operation is `failed` and nothing was sent; from `submitSignatures`, nothing changed | Fix the signer or the wallet's key; after `transfer`, retry with a **new** key; after `submitSignatures`, submit the right signatures |
| `KEY_NOT_EXPORTABLE` | `exportKey` on a signer not created as exportable | Create the signer with `exportable: true`, or do not export |
| `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW`, `NONCE_TOO_HIGH`, `TX_REFUSED` with state `stalled` | Node refused signed bytes | `rebroadcast` after the fix, `replace` or `cancel`; never a new key |
| `NONCE_CONFLICT` | A cancel or replacement lost: the original is already mined | Wait for the original |
| `NONCE_CONFLICT` with `details.heldBy` | The signed transaction is identical to another Operation's, so it would pay once for both; nothing was sent. From `transfer` or `submitSignatures` the Operation is `failed`, or, if it is still `prepared` or `awaiting-signature` (a renew or version conflict), repeat with the **same** key (for `submitSignatures`, resubmit the signatures) so it is refused and failed. From `replace`, `cancel` or `rebuild` it is unchanged | `failed`: retry with a **new** key. `replace` or `cancel`: use another fee spec. `rebuild`: rebuild later. A later build (a new block, or the driver's build variant) gives different bytes |
| `SEQUENCE_BUSY` while recording a signed transaction | Another process is recording an identical transaction right now; nothing was recorded | Repeat the call (the **same** key, fee spec or signatures). For `submitSignatures`, resubmit the signatures |
| `SEQUENCE_BUSY` waiting for the address lease | Another Operation held the wallet's address lease for `lifecycle.leaseWaitMs` (a slow signer, for example); nothing was reserved | Retry later with the **same** key, or raise `leaseWaitMs` |
| `SEQUENCE_BUSY` with `context.blockingOperationId` | A seqno wallet (TON) still has that Operation's message in flight | Retry later with the same key |
| `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` with state `failed` or `expired` | Proven terminal failure: the transaction ran and failed, expired, or another transaction is final in its slot | Reconcile; a new transfer with a new key is safe |
| `TX_UNEVIDENCED` with state `failed` | The transaction executed, but the chain shows no transfer to the recipient: a token that logged none (EVM, Tron), or jettons sent to a wallet the master does not name (TON). The observation's `failure` is `'unevidenced'`. **Value may have moved** | Treat it like an unknown outcome: check the chain (`bc.getTransaction(attempt.ref.id)`, the recipient's balance) and route it to a person before you pay again ([token verdicts](../build/confirmations.md)) |
| `TX_REJECTED` | Nodes rejected every Attempt as never valid; nonce released | Fix the cause; retry with a **new** key |
| Tron: `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes, or claimed they are invalid; they may still land. A liar and a genuine refusal look the same | Never pay again: repeat only with the **same** key. `rebroadcast` after the fix; `rebuild` only once the Operation is `expired` ([Fix a stuck transfer](../build/stalled.md)) |
| Solana: `TX_REFUSED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes (often `blockhash not found`), or claimed a signature the library found valid is invalid; they may still land until their window has passed | Never pay again: `rebroadcast` while the blockhash is valid, or repeat only with the **same** key; the workers never resend it. `rebuild` only once the Operation is `expired` |
| TON: ambiguous, or `stalled` after a refusal | toncenter answers every refusal with HTTP 500 ("maybe sent"); the message may land until it expires | Never a new key. Wait for `final`, `failed` or `expired`; `rebuild` only once it is `expired` |
| TON: `TX_REPLACED` | A request signed with the wallet's key, not this transfer, used its seqno | Find what else holds the key and stop it; then a new key is safe |
| `TIMEOUT` | A wait ran out; state unchanged | Wait again |
| `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_INCONSISTENT` (not ambiguous) | A read failed, or a proof could not reach its quorum | Retry later |
| `RPC_ERROR` | An endpoint's definitive refusal of a read (`details.status`, the HTTP status); for an address an indexer will not serve, every configured indexer refused | Fix the request, or add an endpoint that serves it ([Bitcoin indexers](./networks/bitcoin.md)) |
| `PROVIDER_MISCONFIGURED` | The endpoint serves another network, or refused the credentials (`details.httpStatus` 401 or 403) | Fix the configuration |
| `FENCING` | The address lease or a worker's claim moved to another process while this one worked; this write was refused | Read the Operation again; repeat with the **same** key if it is not done |
| `VERSION_CONFLICT` | The Operation changed under this write | Read it again and repeat; it is retryable |
| `NOT_FOUND` | No Operation has this id in this namespace | Check the id and the container's `namespace` |
| `INVALID_TRANSITION` | Not allowed in this state, or the container is closed | Read the state first |
| `UNSUPPORTED_CAPABILITY` | The handle cannot do this | Check `bc.supports(…)` |
| `SCANNER_REORG_TOO_DEEP` | Reorg deeper than the scanner window | Stop crediting; reset the cursor explicitly |
| `RECORD_FORMAT_UNSUPPORTED` | A newer crypto-aio stored this Operation, during a rolling upgrade | Upgrade this process; the record is unchanged ([upgrades](../explore/stores.md#upgrades-and-the-record-format)) |

## Error fields

Semver covers an error's `code`, `category`, `retryable` and `ambiguous`, and these `details`
and `context` fields where the codes above carry them. Their values are decimal strings in
base units, or as noted. Message texts, observation `reason` texts and any other field are
not covered ([Versioning and stability](./stability.md)).

| Field | Carried by | Value |
| --- | --- | --- |
| `context.operationId`, `context.attemptId` | Errors about one Operation or Attempt | Ids |
| `context.blockingOperationId` | `SEQUENCE_BUSY` on a seqno wallet | The Operation in flight |
| `details.required`, `details.available` | `INSUFFICIENT_FUNDS` | What the transfer needs, and what the wallet holds |
| `details.required` with `details.maxFeePerGas`, `details.maxGasLimit`, `details.maxFeeLimit` or `details.maxComputeUnitPrice` | `INVALID_INTENT` for a fee above an EVM, Tron or Solana bound | The value asked for, and the bound |
| `details.heldBy` | `NONCE_CONFLICT` for an identical transaction | The other Operation |
| `details.causeCode` | `STATE_UNRECORDED` | The code of the failure behind it |
| `details.packages` | `DEPENDENCY_MISSING` | The package names to install |
| `details.missing`, `details.ordering` | `CONFIG_INVALID` for a plugin driver that disagrees with its manifest | The capabilities it lacks; the ordering it declares |
| `details.status` | `RPC_ERROR` from an HTTP endpoint | The HTTP status |
| `details.httpStatus` | `PROVIDER_MISCONFIGURED` for refused credentials | 401 or 403 |
