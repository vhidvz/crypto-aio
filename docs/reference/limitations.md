---
title: Known limitations
description: What crypto-aio does not do yet, what each limit can cost, and what to do about it.
---

# Known limitations

What crypto-aio does not do yet, and what to do about it. None of these leaks a secret, and
none can make the library sign a second payment on its own. Most can only stall an Operation
or a read, the safe direction. Each is a candidate for a 1.x minor release, under the rules
in [Versioning and stability](./stability.md).

## Two that can make a paid transfer look failed

A transfer that paid but reads as failed invites a second payment by hand, so know these two:

- **A deprecated USDT on Tron.** Tether's Tron contract can deprecate itself in favour of a
  new one (its `upgradedAddress`). If that ever happens, a USDT transfer still moves the
  money, but the old contract logs no `Transfer`, so the transfer fails with
  `TX_UNEVIDENCED`: value may have moved. It has not happened; the fix, when it does, is to
  move the `USDT` alias to the new contract.
- **A TON bounce on one indexer's word.** `failed` with `transfer bounced` rests on the
  indexer service's answer. With a single indexer service, a lying one could report a bounce
  for a transfer that landed. Configure two independent indexer services, as the
  [TON page](./networks/ton.md) recommends.

## Trust and evidence

- **Deposits are `observed`, never `proven`.** No driver proves a deposit yet, and Bitcoin
  and Tron block pages are not bound to their block header. Credit
  deposits as [Receive deposits](../build/receive.md) explains: confirm each one you credit
  with a second read.
- **A proof is only as independent as your endpoints.** A proof needs `proofQuorum`
  endpoints, capped by the endpoints you configured: with one endpoint configured, that
  endpoint proves alone. Give each network endpoints from independent providers, three or
  more, so one outage does not stall proofs.
- **EVM proofs compare raw answers.** Two honest endpoints that format an answer differently
  read as a disagreement, so the verdict waits; it never decides wrongly.

## Things that can stall

- **Proofs wait while an endpoint is down.** With `proofQuorum` endpoints configured and one
  of them down, `final` waits for it to come back (unless `transport.degradedProofs` is on).
- **A disagreeing endpoint stays in the proof set.** After a quorum disagreement no endpoint
  is demoted, so a lying endpoint among the first proof endpoints stalls verdicts until you
  remove it. Outside proofs, a quorum read stops at the first endpoint's definitive error, so
  one token can stay unresolvable until a restart.
- **A rate-limited proof endpoint stays counted.** While it answers `429`, proofs wait for
  it. Rate limits are per transport, not per method or per host: toncenter, for one, limits
  by IP across its v2 and v3 APIs and every handle's transport.
- **An EIP-7702 authorization that uses the sender's nonce** leaves the EVM verdict
  undecided.
- **A refusal can hide behind `dropped`.** After an ambiguous send, a node's later refusal of
  the same bytes shows as `dropped`, and the Operation stays `submitted`. A repeat with the
  same key, `rebroadcast` or recovery records the refusal again.
- **A hung signer slows a worker pass.** If a wallet's `getPublicKey` hangs, each Operation
  of a pass that every node rejected can wait up to `signTimeoutMs` for it.
- **The same key used outside crypto-aio.** While an endpoint lags, nonce reconciliation can
  reclaim a nonce that a transaction sent from outside the library already used. The
  transfer that reuses it fails with `TX_REPLACED`; nothing is paid twice.

## Not there yet

- **A gas-limit bound on EVM.** `eth_estimateGas` sets the gas limit. An inflated estimate
  only raises the reserved maximum (the funds check refuses what the wallet cannot cover),
  but no operator bound exists. The OP Stack operator fee is not in the fee report.
- **Hardware-wallet key origins on Bitcoin.** PSBTs carry no `bip32Derivation`.
- **TON batches** have no outcome per leg, and `UQ…` addresses of active contracts are not
  sent bounceable on request.
