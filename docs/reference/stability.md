---
title: Stability before 1.0
description: What may change before crypto-aio 1.0, surface by surface.
---

# Stability before 1.0

crypto-aio is pre-1.0 (`0.x`). Breaking changes can happen in a minor release, and they are
listed in the changelog. Recent changes are an example: `Transfer` became a union
with an unresolved-asset variant, `TERMINAL_STATES` became an array, and `Scanner` became a
type-only export (get a scanner from `bc.scanner()`).

| Surface | Expectation |
| --- | --- |
| Handle and container API, configuration shape, `Amount` / `Address` / asset model, error codes, event names and payloads, store ports and their contract suites | Intended to stay; changes only for real-adapter findings |
| Driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverContext` | **Likely to change** while real families are added. It changed recently (`ProofSource.blockHash`, `createNativeClient` returning `{ client, close? }`) and has open questions, such as how drivers get token decimals |
| Family `ext` APIs and fee override shapes | Defined by each family's adapter |
| `crypto-aio/testing` | Public and documented; the fake chain's wire protocol is not an API |
| `crypto-aio/native` | **Outside semver.** The SDK's API is the SDK's |

## Known gaps

What 0.1.0 does not do yet, and what to do about it. None of these leaks a secret, and none can
make the library sign a second payment on its own. Most can only stall an Operation or a read,
the safe direction.

### Two that can make a paid transfer look failed

A transfer that paid but reads as failed invites a second payment by hand, so know these two:

- **A deprecated USDT on Tron.** Tether's Tron contract can deprecate itself in favour of a new
  one (its `upgradedAddress`). If that ever happens, a USDT transfer still moves the money, but
  the library checks the event of the old contract and reports the transfer `failed`. It has not
  happened; the fix, when it does, is to move the `USDT` alias to the new contract.
- **A TON bounce on one indexer's word.** `failed` with `transfer bounced` rests on the indexer
  service's answer. With a single indexer service, a lying one could report a bounce for a
  transfer that landed. Configure two independent indexer services, as the
  [TON page](./networks/ton.md) recommends.

### Trust and evidence

- **Deposits are `observed`, never `proven`.** No driver proves a deposit yet, and Bitcoin and
  Tron block pages are not bound to their block header. Credit deposits as
  [Receive deposits](../build/receive.md) explains: confirm each one you credit with a second read.
- **The proof quorum has a floor of one.** A proof needs `min(requested, counted)` endpoints, and
  at least one. When every other endpoint is out of the count (its circuit open), the one left
  proves alone. Give each network endpoints from independent providers.
- **EVM proofs compare raw answers.** Two honest endpoints that format an answer differently read
  as a disagreement, so the verdict waits; it never decides wrongly.

### Things that can stall

- **A disagreeing endpoint stays in the proof set.** After a quorum disagreement no endpoint is
  demoted, so a lying endpoint among the first proof endpoints stalls verdicts until you remove
  it. Outside proofs, a quorum read stops at the first endpoint's definitive error, so one token
  can stay unresolvable until a restart.
- **A rate-limited proof endpoint stays counted.** While it answers `429`, proofs wait for it.
  Rate limits are per transport, not per method or per host: toncenter, for one, limits by IP
  across its v2 and v3 APIs and every handle's transport.
- **`status()` reads healthy before an endpoint's height is known.**
- **A queued transfer waits at most `leaseMs`.** A transfer queued behind one that signs for up
  to `signTimeoutMs` (120 s by default) fails `SEQUENCE_BUSY` after `leaseMs` (30 s); there is no
  option to wait longer. Repeat it with the same idempotency key.
- **An EIP-7702 authorization that uses the sender's nonce** leaves the EVM verdict undecided.
- **A refusal can hide behind `dropped`.** After an ambiguous send, a node's later refusal of the
  same bytes shows as `dropped`, and the Operation stays `submitted`. A repeat with the same
  key, `rebroadcast` or recovery records the refusal again.
- **A hung signer slows a worker pass.** If a wallet's `getPublicKey` hangs, each Operation of
  a pass that every node rejected can wait up to `signTimeoutMs` for it.
- **Recovery cannot check an Operation whose wallet is gone.** A `signed` or ambiguous
  Operation whose wallet no longer resolves (its configuration was removed, say) is counted
  `failed` in the `RecoveryReport` without its check. Restore the wallet and recover again.
- **The same key used outside crypto-aio.** While an endpoint lags, nonce reconciliation can
  reclaim a nonce that a transaction sent from outside the library already used. The transfer
  that reuses it fails with `TX_REPLACED`; nothing is paid twice.

### Not there yet

- **Decimals you supply.** A token or jetton whose decimals the chain does not give cannot be
  sent until a [plugin](../explore/plugins.md) registers them; there is no decimals option on a
  transfer, since a wrong default could scale an amount a thousandfold.
- **A gas-limit bound on EVM.** `eth_estimateGas` sets the gas limit. An inflated estimate only
  raises the reserved maximum (the funds check refuses what the wallet cannot cover), but no
  operator bound exists. The OP Stack operator fee is not in the fee report.
- **A repeat cancel on EVM** ranks earlier cancels by their total charges, not by price, so it
  may need an explicit `fee`.
- **A sanity bound on Solana's fee quote** (`getFeeForMessage`). A wrong quote can mis-state an
  estimate or stall a transfer; it is never signed into one.
- **Hardware-wallet key origins on Bitcoin.** PSBTs carry no `bip32Derivation`.
- **A p2tr wallet with an ECDSA-only signer** fails at signing, before anything is broadcast.
- **TON batches** have no outcome per leg, and `UQ…` addresses of active contracts are not sent
  bounceable on request.
- **A distinct error for a token that did not log its transfer.** It is `TX_REVERTED`, as
  [Errors](./errors.md) describes.
- **A structured HTTP status on `PROVIDER_MISCONFIGURED`.** The message names the status.
