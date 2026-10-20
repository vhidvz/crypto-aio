---
title: Upgrade to 1.0
description: Every breaking change between crypto-aio 0.1.0 and 1.0, and what to change in your code, your stores and your configuration.
---

# Upgrade to 1.0

crypto-aio 1.0 settles the last parts of the API that 0.1.0 left open. Most applications
change nothing; read the sections that match what you use. Every change is also in the
[changelog](https://github.com/vhidvz/crypto-aio/blob/main/CHANGELOG.md), and from 1.0 on,
[semver](./stability.md) applies.

Operations that 0.1.0 stored are read as they are: no data migration is needed, and an
idempotency key repeated after the upgrade finds its Operation.

## Everyone

- **Node.js 22.12 or later.** Earlier 22.x releases are no longer supported (Solana already
  needed 22.12).
- **`TX_UNEVIDENCED`.** A transfer whose transaction executed but shows no transfer to the
  recipient now fails with `TX_UNEVIDENCED`, not `TX_REVERTED`: an EVM or Tron token that
  logged no `Transfer` to the recipient, or TON jettons sent to a wallet the master does not
  name. **Value may have moved**, so treat it like an unknown outcome: check the chain before
  paying again. If your code handles `TX_REVERTED` as "safe to pay again", it no longer sees
  these cases there, which is the point; add a branch for `TX_UNEVIDENCED` that routes to a
  person ([Errors](./errors.md#what-to-do-about-each-error)).
- **Proofs wait for every configured endpoint's share.** A proof needs `proofQuorum`
  endpoints (2) capped by the endpoints you configured, even while some are down: with two
  endpoints and one down, `final` waits for it. Configure three or more endpoints, from
  independent providers, so one outage leaves enough. To keep 0.1.0's behavior, where the
  one endpoint left proves alone, set `transport: { degradedProofs: true }`.
- **Endpoint health reads `unknown` until its height is known.** `getNetworkStatus()` and
  `bc.ready()` no longer count an endpoint as `healthy` from its identity alone: `ready()`
  now fails with `PROVIDER_UNAVAILABLE` when no endpoint has answered its height probe.

## If you read `RecoveryReport`

`aio.operations.recover()` reports `unresent`: Operations whose wallet no longer resolves are
now checked on chain, and counted there rather than in `failed`. Restore the wallet and
recover again to resend them.

## If you write a durable store

Run the contract suites from `crypto-aio/testing` again: they now check two more fields.

- Operation records carry `format` (`OPERATION_FORMAT`, 1). Store it like every other field.
  A record without one, as 0.1.0 wrote them, reads as format 1, so existing rows need no
  migration.
- Observations carry `failure` (`'reverted'` or `'unevidenced'`) on a failed Attempt.
  Store it, and clear it when an observation is replaced without it, as you do `reason`.

During a rolling upgrade, a process never reads a record of a newer format: it throws
`RECORD_FORMAT_UNSUPPORTED`, and its workers leave such records to newer processes
([upgrades](../explore/stores.md#upgrades-and-the-record-format)).

## If you construct handles or containers yourself

- `Blockchain`'s constructor is private, and its internal `protected` methods are gone from
  the type declarations: create handles with `aio.blockchain()` or `Blockchain.create()`.
  Subclassing a handle was never supported.
- `CryptoAio`'s constructor has one signature, `new CryptoAio(options?)`.

## If you write a chain family plugin

The driver port is final for 1.0 ([Write a chain family plugin](../explore/plugins.md)):

- `observe` and `includedFinal` report what failed with `failure`: set `'unevidenced'` when
  a transaction executed but shows no transfer to the recipient.
- `BuildContext.decimals` gives the decimals the core scaled the amounts with. A driver whose
  transaction signs decimals must refuse a mismatch with what the chain says.
- `ReplacementPolicy.comparePrice` (optional) ranks two transactions of one slot by price,
  for repeat cancels.
